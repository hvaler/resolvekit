/**
 * A small JSON Schema check for the input schemas MeterMCP's tools publish (zod shapes as JSON Schema): type
 * object/string/number/integer/boolean/array, properties, required, additionalProperties false, enum, minimum/maximum,
 * minLength/maxLength, minItems/maxItems, items. Other keywords are ignored. No dependency: the engine validates the
 * model's arguments before any call, and these schemas use nothing more.
 */
import type { JsonSchema } from './types.ts';

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** The problems of `value` against `schema`, one line each (empty when it conforms). `path` names the value. */
export function validate(schema: JsonSchema, value: unknown, path = 'arguments'): string[] {
  const s = schema as Record<string, any>;
  const errors: string[] = [];
  const type = s.type as string | undefined;
  if (type) {
    const t = typeOf(value);
    const fits =
      type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : t === type;
    if (!fits) return [`${path} must be ${type === 'integer' ? 'an integer' : `a${/^[aeiou]/.test(type) ? 'n' : ''} ${type}`}`];
  }
  if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => e === value)) errors.push(`${path} must be one of ${s.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) errors.push(`${path} must be at least ${s.minimum}`);
    if (typeof s.maximum === 'number' && value > s.maximum) errors.push(`${path} must be at most ${s.maximum}`);
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) errors.push(`${path} must be more than ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) errors.push(`${path} must be less than ${s.exclusiveMaximum}`);
  }
  if (typeof value === 'string') {
    const n = [...value].length;
    if (typeof s.minLength === 'number' && n < s.minLength) errors.push(`${path} must have at least ${s.minLength} characters`);
    if (typeof s.maxLength === 'number' && n > s.maxLength) errors.push(`${path} must have at most ${s.maxLength} characters`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) errors.push(`${path} must have at least ${s.minItems} items`);
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) errors.push(`${path} must have at most ${s.maxItems} items`);
    if (s.items && typeof s.items === 'object') value.forEach((v, i) => errors.push(...validate(s.items, v, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const v = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    // Top-level parameters are named as is; nested ones with their parent.
    const at = (k: string) => (path === 'arguments' ? k : `${path}.${k}`);
    for (const r of (s.required ?? []) as string[]) if (!Object.hasOwn(v, r)) errors.push(`${at(r)} is required`);
    for (const [k, x] of Object.entries(v)) {
      if (Object.hasOwn(props, k)) errors.push(...validate(props[k]!, x, at(k)));
      else if (s.additionalProperties === false) errors.push(`${at(k)} is not a parameter of this tool`);
    }
  }
  return errors;
}
