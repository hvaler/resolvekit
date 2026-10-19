[English](../../user-guide/getting-started.md) | [Español](getting-started.md)

# Primeros pasos

Elige el camino que te corresponde. Las etiquetas en **negrita** son los nombres exactos que aparecen en pantalla.

| Eres | Empieza aquí | Necesitas |
|---|---|---|
| Cualquier curioso | [Explore demo](#explore-demo) | Un navegador |
| Un jurado o un revisor invitado | [Evaluación en sandbox](#evaluación-en-sandbox-revisores) | El enlace de revisor del formulario de entrega |
| Un comerciante | [Tu espacio de comerciante](#tu-espacio-de-comerciante) | Una cuenta de PayPal (hoy verás una pantalla de espera) |
| Un desarrollador | [Modo local](#modo-local) | Node.js 24+, una app de sandbox de PayPal (opcional), una clave de modelo (opcional) |

## Explore demo

1. Abre la dirección de ResolveKit y elige **Try the demo** (o ve a `/demo`). Sin iniciar sesión.
2. La barra de la app dice «Explore demo · fictional cases, nothing is sent». Cada caso funciona sobre un simulador de
   PayPal en tu navegador; no se llama a ningún modelo y nada llega a PayPal.
3. La bandeja **Disputes** muestra todos los casos ficticios. Úsala así:
   - **Saved filters** (filtros guardados): **Needs my approval**, **Agent purchase**, **Processing by PayPal**, **Due in 48 h**;
     **Clear all** los quita.
   - Cuadro de búsqueda «Search ID, reason, status, next step».
   - Mayús + clic en la cabecera de una columna añade una ordenación; **Reset columns** restaura la disposición. El
     orden, el ancho de las columnas y la ordenación se guardan en este dispositivo.
   - Las flechas del teclado mueven la selección; **Enter** o un doble clic abre un caso.
   - **Readiness** («3 of 5 present») muestra lo completa que está la evidencia. No predice la decisión de PayPal.
4. Abre un caso para ver el expediente: [Casos y evidencias](cases-and-evidence.md).

Lo que la demo no puede hacer: **+ Add evidence** está desactivado («Adding your own evidence reads it on the ResolveKit
server; it's available in the sandbox evaluation, not in the demo.»), **Re-run with AI** necesita el servidor, y una
frase editada no puede volver a comprobarla el modelo (se queda en **Needs review**, «this edit was not re-checked»).
Aun así puedes recorrer la revisión, la aprobación y la relectura simulada.

## Evaluación en sandbox (revisores)

La evaluación en sandbox es el espacio de trabajo de un vendedor del **sandbox** de PayPal. Sus casos están vinculados a
disputas reales del sandbox; el envío es real (`provide-evidence`) pero no se mueve dinero real.

1. Abre el enlace de revisor del formulario de entrega. La página dice «Checking the invite…» y después
   «<workspace> invited you as a reviewer», con lo que puedes hacer y «Access until <date>».
2. Escribe **Your name, as the audit trail will show it** (1–60 caracteres). Tus aprobaciones llevan este nombre.
3. Elige **Create a passkey and join** (para volver a iniciar sesión más tarde en este dispositivo) o **Join for this
   browser only** (termina con la sesión, 12 horas). Si el navegador no puede crear passkeys, solo aparece la segunda
   opción.
4. Llegas a **Disputes**. La barra de la app dice «Sandbox evaluation · <workspace> · PayPal sandbox». Solo aparecen
   los casos vinculados; al abrir cada uno se muestra **PayPal sandbox · live** con su id de disputa.
5. Encima de la cuadrícula hay dos enlaces: **Explore demo · N more fictional cases** y **Try the buying agent**.

Siguiente: [Casos y evidencias](cases-and-evidence.md) → [Revisar y enviar](review-and-submit.md) →
[Agente comprador](buying-agent.md). Los jurados tienen además la [Guía de revisión](../judges/review-guide.md).

Si el enlace dice «This invite was already used», «This invite has expired» o «This invite was revoked», pide al Owner
del espacio de trabajo un enlace nuevo. Si la bandeja dice «No sandbox disputes are bound right now.», todavía no hay
nada que responder; usa la Explore demo.

## Tu espacio de comerciante

1. Elige **Sign in** y después **Continue with PayPal**. PayPal te pide aprobar una solicitud sin cargo para que
   ResolveKit pueda confirmar qué cuenta es la tuya: «No money moves and no agreement is created.»
2. Tras aprobar, vuelves con la sesión iniciada como **Owner** de tu espacio de trabajo.
3. Salvo que tu cuenta sea el vendedor de sandbox de la evaluación, verás: «You're signed in with PayPal. Access to your
   disputes isn't available yet.» La conexión de disputas para comerciantes nuevos está en validación; ResolveKit no
   puede leer tus disputas ni enviar respuestas por tu negocio.
4. Desde ahí: **Explore demo**, **Members and invites** (invitar a alguien «doesn't connect your disputes to PayPal»),
   **Sign out**, **Use another PayPal account**.

Iniciar sesión no da a ResolveKit ningún acceso a tus disputas. Estado de la conexión de disputas: **Pendiente** (ver
[Limitaciones](../product/limitations.md)).

## Modo local

Para desarrollo y demos sin conexión en una sola máquina. No hay inicio de sesión: tú eres el comerciante («Alex Moreno»
en la barra de la app) y actúas como Owner.

```bash
cp .env.example .env   # optional: PayPal sandbox app credentials and a model key; never commit it
npm install
npm run server         # http://127.0.0.1:8787
npm run dev            # http://localhost:5173
```

- Sin el servidor, o sin credenciales de PayPal, todos los casos funcionan sobre el simulador.
- Para usar disputas reales del sandbox, vincula casos en `apps/server/bindings.json` (a partir de
  `bindings.example.json`).
- Sin `GEMINI_API_KEY` ni `GROQ_API_KEY` el servidor solo muestra análisis guardados y el agente comprador no puede
  ejecutarse.
- Un control **Dev · simulator** (abajo a la izquierda, en builds de desarrollo o con `?dev`) elige qué hace el PayPal
  simulado tras un envío y puede simular que PayPal no responde.

Configuración completa: [Desarrollo local](../technical/local-development.md) y [Configuración](../technical/configuration.md).

## En todas partes

- **Light / Dark** y **Teal / Indigo** cambian el tema.
- El menú de la cuenta (el nombre de tu espacio de trabajo y la etiqueta de tu rol) muestra quién eres, «signed in with
  …», la conexión con PayPal del espacio de trabajo, **Explore demo**, **Sign out**, **Sign out of all devices**,
  **Use another PayPal account** y «The three environments». Ver [Cuentas y permisos](accounts-and-permissions.md).
