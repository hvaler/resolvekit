/**
 * Prompt-injection DETECTION. This is a flag for the merchant (a UX signal), never the security boundary: the
 * analysis is safe without it because documents are delimited as data, the model never chooses the PayPal action
 * or the evidence type (domain rules do), every claim must cite a verbatim quote, and each sentence is verified in
 * isolation against its own quotes only (see pipeline.ts). Detection can therefore err towards flagging.
 *
 * Signals, merged (any one flags the document; none can clear another's flag):
 * - pattern: this deterministic scan, on text normalised against evasion (NFKC, zero-width/bidi/control characters
 *   removed, homoglyphs and leetspeak mapped, whitespace collapsed, lowercase), in English, Spanish, French, German
 *   and Portuguese, plus fake role lines / markup and base64 or hex blocks that decode to such text;
 * - model: the extraction call reports instruction-bearing passages;
 * - classifier: a separate small model call that only screens for instructions (pipeline.ts).
 */
import type { AnalysisDocument, InjectionFlag } from './types.ts';
import { normalize } from './verify.ts';

// Zero-width, bidi controls, soft hyphen, other format/control characters.
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// Common confusables (Cyrillic, Greek, Latin variants) → ASCII.
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ɡ: 'g',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c', ϳ: 'j',
  ı: 'i', ɩ: 'i', ℓ: 'l', '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '’': "'", '‘': "'", '“': '"', '”': '"',
};
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

/** Text as the scanner sees it: evasions undone, lowercase, accents removed, whitespace collapsed. */
export function normalizeForScan(text: string): string {
  const nfkc = text.normalize('NFKC').replace(INVISIBLE, '');
  const mapped = Array.from(nfkc.toLowerCase(), (ch) => HOMOGLYPHS[ch] ?? ch).join('');
  // Strip accents after mapping so "instrucciónes" / "règles" / "Anweisungen" match plain patterns.
  return mapped.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/** Leetspeak undone (separate variant: digits are normal in documents). "1gn0r3 4ll" → "ignore all". */
const unleet = (t: string) => t.replace(/[013457@$!]/g, (c) => LEET[c] ?? c);

const AI = '(?:reviewer|analyst|ai|a\\.i\\.|assistant|model|llm|chatbot|bot|gpt|moderator|adjudicator|revisor|analista|asistente|modelo|ia|evaluateur|relecteur|assistant ia|ki|pruefer|prufer|gutachter|assistent|modell|avaliador|assistente)';

const PATTERNS: RegExp[] = [
  // Addressed to the reviewer / AI: "To the reviewer:", "Note to the AI", "Al revisor:", "À l'IA :", "An den Prüfer:"
  new RegExp(`\\b(?:to|dear|attention|note to|message to|instructions? for|for any|al|a la|para el|para la|nota para|au|a l'|a la|pour l'|pour le|an den|an die|fur den|fur die|ao|a|para o|para a)\\s+(?:the\\s+|any\\s+|el\\s+|la\\s+|le\\s+|l'|den\\s+|die\\s+|o\\s+)?(?:ai\\s+|human\\s+)?${AI}s?\\b\\s*(?:[:,\\-]|reading)`),
  // "ignore / disregard / forget … instructions / evidence / tracking / above"
  /\b(?:ignore|disregard|forget|overlook|override|bypass)\b[^.\n]{0,60}\b(?:instructions?|prompt|rules?|evidence|records?|tracking|documents?|above|previous|prior|system|guidelines?)\b/,
  // ES: ignora/olvida/omite … instrucciones/reglas/anteriores/seguimiento/pruebas
  /\b(?:ignora|ignore|olvida|olvide|omite|descarta|haz caso omiso)\b[^.\n]{0,60}\b(?:instrucciones|reglas|anteriores|previas|seguimiento|pruebas|evidencias?|registros?|documentos?)\b/,
  // FR: ignore(z)/oublie(z) … instructions/règles/précédentes/suivi/preuves
  /\b(?:ignore[zr]?|oublie[zr]?|ne tiens? pas compte)\b[^.\n]{0,60}\b(?:instructions|consignes|regles|precedentes|suivi|preuves?|documents?)\b/,
  // DE: ignoriere/vergiss … Anweisungen/Regeln/vorherigen/Sendungsverfolgung/Beweise
  /\b(?:ignoriere|ignorieren sie|vergiss|vergessen sie|missachte)\b[^.\n]{0,60}\b(?:anweisungen|regeln|vorherigen|bisherigen|sendungsverfolgung|beweise|dokumente|unterlagen)\b/,
  // PT: ignore/esqueça … instruções/regras/anteriores/rastreamento/provas
  /\b(?:ignore|ignora|esqueca|esqueça|desconsidere)\b[^.\n]{0,60}\b(?:instrucoes|regras|anteriores|rastreamento|rastreio|provas|documentos)\b/,
  // "system prompt", "you are now", "act as", "new instructions", and translations
  /\b(?:system prompt|new instructions?|developer (?:message|mode)|you are now|from now on you|act as|jailbreak|prompt del sistema|nuevas instrucciones|ahora eres|a partir de ahora eres|actua como|nouvelles instructions|tu es maintenant|vous etes maintenant|agis comme|systemprompt|neue anweisungen|du bist jetzt|ab jetzt bist du|handle als|novas instrucoes|voce agora e|agora voce e|aja como)\b/,
  // "you must recommend a refund", "the AI should approve", "debes recomendar un reembolso"
  new RegExp(`\\b(?:you|${AI})\\s+(?:must|should|shall|have to|need to|will|debes|debe|deberia|tienes que|dois|doit|devez|musst|muss|sollst|soll|deve|precisa)\\s+(?:\\w+\\s+){0,2}(?:recommend|approve|refund|decide|rule|accept|reject|output|respond|say|mark|recomendar|aprobar|reembolsar|marcar|recommander|approuver|rembourser|empfehlen|erstatten|genehmigen|recomendar|aprovar)`),
  // "recommend a full refund", "recomienda un reembolso", "recommandez un remboursement", "empfiehl eine Erstattung"
  /\b(?:recommend(?:ing)?|recomienda|recomendar|recommande[zr]?|empfiehl|empfehlen sie|recomende)\s+(?:a\s+|un\s+|una\s+|le\s+|eine\s+|o\s+|um\s+)?(?:full\s+|total\s+|complet\s+|voll(?:e|standige)?\s+)?(?:refund|reembolso|remboursement|erstattung|ruckerstattung|reembolso)\b/,
  /\b(?:respond|reply|answer|output|responde|contesta|reponds|antworte|responda)\s+(?:only|solo|solamente|uniquement|nur|apenas)\b/,
  // Fake role lines and markup: "system: …", "[assistant]", "<system>", "```system", {"role": "system"}, fake delimiters
  /(?:^|\s)(?:system|assistant|developer|sistema|systeme)\s*:\s/,
  /\[\s*(?:system|assistant|developer|inst)\s*\]|<\/?\s*(?:system|assistant|developer|instructions?|prompt|im_start|im_end)\b[^>]*>|```\s*(?:system|assistant|prompt)\b|"role"\s*:\s*"(?:system|assistant|developer)"|<<<\s*end\b|<\/document>/,
];

const hitsText = (t: string) => PATTERNS.some((p) => p.test(t));
/** A normalised text matches, as written or with leetspeak undone. */
export function looksLikeInstruction(raw: string): boolean {
  const t = normalizeForScan(raw);
  return hitsText(t) || hitsText(unleet(t)) || decodedPayloads(raw).some((d) => hitsText(normalizeForScan(d)));
}

const printable = (s: string) => s.length > 0 && /^[\x09\x0A\x0D\x20-\x7E -ɏ]*$/.test(s) && /[a-z]{3}/i.test(s);

function fromBase64(b: string): string | null {
  try {
    const bin = atob(b.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return printable(s) ? s : null;
  } catch {
    return null;
  }
}

function fromHex(h: string): string | null {
  try {
    const bytes = Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return printable(s) ? s : null;
  } catch {
    return null;
  }
}

/** Base64 / hex blocks in the text that decode to readable text (tracking numbers and hashes do not). */
export function decodedPayloads(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.match(/[A-Za-z0-9+/_-]{20,}={0,2}/g) ?? []) {
    if (/^[0-9a-f]+$/i.test(m) && m.length % 2 === 0) {
      const h = fromHex(m);
      if (h) out.push(h);
      continue;
    }
    const b = fromBase64(m.length % 4 ? m + '='.repeat(4 - (m.length % 4)) : m);
    if (b) out.push(b);
  }
  return out;
}

const ENDS_SENTENCE = /[.!?"”')]\s*$/;

/**
 * One flag per document: the first line (or pair of lines, for a pattern split by a line break) that looks like an
 * instruction, continued while the sentence runs on. The quote is the original text. The case file's own
 * "Received: …" metadata line is not document content and is not scanned.
 */
export function scanForInjection(docs: readonly AnalysisDocument[]): InjectionFlag[] {
  const out: InjectionFlag[] = [];
  for (const d of docs) {
    if (d.id === 'D') continue; // PayPal's own record
    const lines = d.lines.map((l) => normalize(l.text)).map((t) => (t.startsWith('Received: ') ? '' : t));
    let at = lines.findIndex((t) => t && looksLikeInstruction(t));
    if (at < 0) at = lines.findIndex((t, i) => t && lines[i + 1] && looksLikeInstruction(`${t} ${lines[i + 1]}`));
    if (at < 0) continue;
    const parts = [lines[at]!];
    for (let i = at + 1; i < lines.length && lines[i] && !ENDS_SENTENCE.test(parts[parts.length - 1]!) && parts.length < 4; i++) parts.push(lines[i]!);
    out.push({ doc: d.id, quote: parts.join(' '), by: ['pattern'] });
  }
  return out;
}

/** Merge flags from several signals. A signal can only add a flag (or a source to one); nothing clears a flag. */
export function mergeFlags(...signals: ReadonlyArray<readonly InjectionFlag[]>): InjectionFlag[] {
  const out: InjectionFlag[] = [];
  for (const list of signals) {
    for (const f of list) {
      const same = out.find((x) => x.doc === f.doc);
      if (same) {
        for (const b of f.by) if (!same.by.includes(b)) same.by.push(b);
      } else out.push({ doc: f.doc, quote: f.quote, by: [...f.by] });
    }
  }
  return out;
}
