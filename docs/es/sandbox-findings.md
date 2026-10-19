[English](../sandbox-findings.md) | [Español](sandbox-findings.md)

# Hallazgos en el sandbox de PayPal (movido)

Esta página se ha movido. Los hallazgos están ahora en
[Integración con PayPal → Hallazgos en sandbox](technical/paypal-integration.md#hallazgos-en-sandbox), junto a los
endpoints a los que dieron forma y separados de las reglas documentadas de PayPal.

Lo que contenía, con sus fechas:

- **08/10/2026**: hallazgos verificados a mano en el sandbox de PayPal (búsqueda de la disputa por captura, unos 5
  minutos hasta que aparece una disputa nueva, `UNDER_REVIEW` primero, evidencia solicitada, el tipo de evidencia que
  PayPal acepta para «not received», tipo de artículo declarado por el comprador, `provide-evidence` multipart, la
  acción `provide_evidence` que desaparece tras un envío, un reembolso parcial hecho a mano).
- **09/10/2026**: un envío de extremo a extremo a través de ResolveKit y su relectura.

Allí se corrigen dos líneas de la tabla antigua: ResolveKit no tiene acción de reembolso (el reembolso fue una
observación manual en el sandbox) y, de las acciones de la fase de consulta, solo está construida **Provide evidence**.
