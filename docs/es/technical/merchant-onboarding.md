[English](../../technical/merchant-onboarding.md) | [Español](merchant-onboarding.md)

# Alta de comerciantes mediante PayPal Platform

**Estado: en validación, no disponible para usuarios.** Un comerciante que hoy inicia sesión con PayPal ve una
pantalla de espera: «Connecting disputes for new merchants is being validated and isn't available yet…», con un
enlace a la demo. ResolveKit no puede leer las disputas de ese comerciante ni enviar respuestas en su nombre. Iniciar
sesión no concede ningún acceso a ellas.

Esta página separa tres cosas que no deben confundirse:

1. **Prueba externa en sandbox lograda**: un paso probado a mano en el sandbox de PayPal el 18/10/2026, **fuera de la
   app**, con una app Platform de sandbox independiente. Evidencia privada, resumida aquí sin ids, cuentas ni
   enlaces; los lectores no pueden reproducirla.
2. **Implementado en la app**: código en este repositorio. En el commit `81c6242` **no hay ninguno**: ni
   `partner-referrals`, ni `merchant-integrations`, ni `PayPal-Auth-Assertion` en ninguna parte de `apps/` ni de
   `packages/`.
3. **Desplegado**: en funcionamiento en el servicio alojado. Solo está desplegada la pantalla de espera.

## Los diez pasos

| # | Paso | Prueba externa en sandbox (18/10/2026, fuera de la app) | Implementado en la app | Desplegado |
|---|---|---|---|---|
| 1 | Configuración de la app Platform (funcionalidades de la API de Disputes `READ_SELLER_DISPUTE`, `UPDATE_SELLER_DISPUTE`) | Logrado con una app de sandbox de tipo Platform; un intento anterior desde una app que no era de plataforma fue rechazado (403) | No | No |
| 2 | Partner Referrals (v2, `integration_type` `THIRD_PARTY`, las dos funcionalidades de disputas, `action_url`) | Logrado (201) | No | No |
| 3 | Consentimiento | Logrado por un vendedor de sandbox independiente (una cuenta business distinta de la plataforma y del vendedor de evaluación) | No | No |
| 4 | Permisos efectivos en `merchant-integrations` | Logrado: `payments_receivable` y `primary_email_confirmed` a true; `disputes/read-seller` y `disputes/update-seller` listados entre los scopes concedidos | No | No |
| 5 | Listado de disputas (`PayPal-Auth-Assertion`) | Logrado (200). Solo apareció la disputa sobre un pago que había procesado la plataforma (primero 0, después 1); las disputas del vendedor sobre sus propias facturas directas no aparecieron | No | No |
| 6 | Lectura de una disputa conocida | 200 para una disputa sobre un pago de Orders v2 que la plataforma creó con el vendedor como beneficiario; 403 `ACTION_NOT_ALLOWED` para dos disputas sobre facturas que el vendedor emitió directamente, una de ellas creada después de activar Invoicing y Transaction search en la app de plataforma | No | No |
| 7 | Respuesta autorizada (`provide-evidence` aprobado explícitamente) | Logrado una vez (200) sobre la disputa procesada por la plataforma | No | No |
| 8 | Relectura | Logrado: la relectura mostró `SUBMITTED_BY_SELLER` | No | No |
| 9 | Aislamiento y revocación | PayPal rechazó los intentos entre vendedores (403 para la disputa de otro vendedor; 400 al listar para un vendedor que no había dado su consentimiento). Revocación y desconexión: no probadas (Pendiente) | No | No |
| 10 | Integración y disponibilidad en ResolveKit (vinculación con el espacio de trabajo con sesión iniciada, fuente de casos por comerciante, aislamiento en el lado de ResolveKit, webhooks de disputas de partner) | No probado: requiere código en la app | No (Pendiente) | No (solo la pantalla de espera) |

Fuente: salidas de los comandos de la prueba externa en sandbox del 18/10/2026, registradas en la sesión de desarrollo;
no se guardan en este repositorio (se omiten los ids).

## La diferencia según el origen del pago (solo una observación)

En estas pruebas, las disputas sobre pagos procesados por la plataforma se podían leer y responder, y las disputas
sobre facturas directas del vendedor no. Es una **observación experimental**: un vendedor, pocos casos, solo sandbox,
nunca probado en live. PayPal no lo documenta, no está confirmado y aquí no se presenta como una regla ni como
el comportamiento de PayPal. Entre las explicaciones posibles están un alcance por diseño ligado al partner que hace
la llamada, un ajuste de cuenta o de app que no encontramos, un comportamiento propio del sandbox u otra cosa.
ResolveKit no promete acceso a todas las disputas de un comerciante, y una lista vacía no debe leerse como «este
comerciante no tiene disputas».

## Pregunta a PayPal

El **18/10/2026** se envió, por el canal de desarrolladores del hackathon, una pregunta sobre si el acceso de
terceros a las disputas está limitado a las transacciones procesadas a través del partner y si una plataforma puede
gestionar todas las disputas de un vendedor que ha dado su consentimiento. **Sin respuesta a fecha de 19/10/2026.**

## Qué documenta PayPal

- Partner Referrals v2 crea un *referral* (solicitud de alta) y devuelve «an `action_url` to which you redirect the customer»;
  `THIRD_PARTY` y las funcionalidades `READ_SELLER_DISPUTE`, `UPDATE_SELLER_DISPUTE`
  ([Partner Referrals v2](https://developer.paypal.com/docs/api/partner-referrals/v2/),
  [esquema](https://developer.paypal.com/api/partner-referrals/v2/schema.yaml)). No se describe a qué disputas
  alcanza.
- El ajuste de la app para la API de Disputes y la concesión de permiso por parte del vendedor
  ([lista de comprobación del alta](https://developer.paypal.com/platforms/seller-onboarding/onboarding-checklist)).
- Comprobaciones del estado del vendedor (`payments_receivable`, `primary_email_confirmed`, `oauth_third_party`)
  ([antes del pago](https://developer.paypal.com/docs/multiparty/seller-onboarding/before-payment/)); la referencia
  v1 que documenta `merchant-integrations` está marcada como obsoleta.
- `PayPal-Auth-Assertion` es «An API client-provided JSON Web Token (JWT) assertion that identifies the merchant»;
  el consentimiento para actuar en nombre del comerciante es un requisito previo
  ([cabeceras de petición](https://developer.paypal.com/api/rest/requests),
  [orders get](https://developer.paypal.com/api/orders/v2/orders-get)).
- Los webhooks de disputas de partner usan los mismos eventos `CUSTOMER.DISPUTE.*`; no se indica si cubren todas las
  disputas de un vendedor ([webhooks de disputas de partner](https://developer.paypal.com/docs/multiparty/disputes-chargebacks/webhooks/)).

## Qué haría falta para construirlo (no diseñado en el código)

El diseño de los tres entornos reserva un estado de espacio de trabajo `connected` (que hoy nunca se produce) y una
tercera fuente de casos, las disputas propias del comerciante en PayPal sin fixtures. Construirlo requeriría, como
mínimo: los pasos 1–10 en código de la app; una fuente de disputas por comerciante en lugar de las vinculaciones; tests de
aislamiento entre comerciantes para rutas, subidas, análisis, cachés y auditoría; y una respuesta firme sobre a qué
disputas puede llegar una plataforma. Nada de esto está implementado. Ver [limitaciones](../product/limitations.md).
