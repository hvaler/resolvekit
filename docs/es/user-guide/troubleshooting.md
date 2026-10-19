[English](../../user-guide/troubleshooting.md) | [Español](troubleshooting.md)

# Solución de problemas

Busca el mensaje que ves (o el más parecido) y sigue la solución. Los mensajes se citan tal como los muestra la app.
Para operadores, ver el [Runbook](../operations/runbook.md).

## Inicio de sesión y acceso

| Ves | Por qué | Solución |
|---|---|---|
| Otra vez la página de inicio de sesión tras «Explore without signing in» | Ese enlace va a `/cases`, que necesita sesión | Usa **Try the demo** o abre `/demo` |
| «You're signed in with PayPal. Access to your disputes isn't available yet.» | Tu espacio de trabajo no es el vendedor de sandbox; la conexión de comerciantes no está disponible | Usa **Explore demo**. Revisores: uníos con el enlace de revisor |
| «Checking your PayPal connection…» (se repite cada 5 s) | El servidor aún no ha leído el vendedor de las disputas vinculadas | Espera; se resuelve cuando PayPal responde |
| «Couldn't read the bound sandbox cases yet. Retrying…» | Falló la lectura de estado del servidor | **Retry now**, o espera (los reintentos se espacian hasta 30 s) |
| «No sandbox disputes are bound right now.» | No hay nada que responder en la evaluación | Usa la Explore demo |
| «Owners only» | Solo el Owner gestiona los miembros | Pídeselo al Owner |
| «This invite was already used / has expired / was revoked» | El enlace no se puede usar | Pide al Owner un enlace nuevo |
| Sesión cerrada tras unas horas | Las sesiones duran 12 horas; «this browser only» termina con la sesión | Inicia sesión con tu passkey, o con una invitación nueva |
| Ha pasado la fecha «Reviewer access until …» | El acceso de revisor terminó | Pídeselo al Owner |
| Errores del inicio de sesión con PayPal | Ver [Cuentas y permisos](accounts-and-permissions.md#formas-de-iniciar-sesión) | — |

## Leer casos

| Ves | Por qué | Solución |
|---|---|---|
| «Couldn't reach PayPal. Showing saved data.» / «Sync delayed» | PayPal o el servidor no respondieron | **Sync now** / **Sync again**; los campos de PayPal muestran «—» hasta que una lectura tenga éxito |
| «Reading this dispute from PayPal…» durante mucho rato | Lectura lenta del sandbox | Espera; recarga |
| **Demo binding mismatch** | La disputa de sandbox vinculada no coincide con el pedido de la demo (p. ej. otro importe) | Informativo; los campos de PayPal mostrados son los de PayPal |
| El enlace de un caso se abre en la Explore demo | En el espacio de evaluación, solo los casos vinculados están en directo; los demás ids abren su gemelo ficticio | Es lo esperado |
| «Case not found» | No existe ese caso en esta zona | **← All cases** |
| **Evidence recorded by PayPal**, borrador de solo lectura | Alguien ya envió evidencia a esta disputa | Lee la evidencia registrada; en la evaluación el caso solo pasa a la siguiente disputa de su reserva si queda alguna |
| «PayPal is processing this new dispute. Actions appear shortly.» | Disputa nueva, `UNDER_REVIEW`, aún sin acciones del vendedor | Espera unos minutos |

## Análisis

| Ves | Solución |
|---|---|
| **Re-run with AI** desactivado: «Sign in required» / «Seller workspace only» | Inicia sesión en el espacio del vendedor |
| «Live-run limit reached (6/hour); next in N min» | Espera |
| «Live runs need the ResolveKit server (npm run server) with a model key» / «No model key (GEMINI_API_KEY / GROQ_API_KEY) on the server» | Modo local: arranca el servidor con una clave |
| «No analysis for these documents: …» | El servidor no está conectado o no tiene un análisis guardado; arráncalo, o pulsa **Re-run with AI** |
| Una frase con «Why: this edit was not re-checked (…)» | La recomprobación falló o no está disponible; vuelve a editarla más tarde, o revísala tú (no se puede enviar mientras esté en **Needs review**) |
| «Analysis pending: it does not include E7 yet…» | **Re-run with AI** para incluir tu evidencia confirmada |
| `DAILY_CAP` «This demo allows N live AI runs per day; the cap resets at …» | Espera al restablecimiento (UTC) |

## Subidas de evidencia

| Ves | Solución |
|---|---|
| **+ Add evidence** desactivado con un motivo | Explore demo, sin sesión, otro espacio de trabajo o evidencia ya enviada; mira el motivo |
| «Adding evidence needs the ResolveKit server (npm run server)» | Modo local: arranca el servidor |
| «The uploads of this case could not be read (…)» | **Retry**; el análisis espera para no dejar fuera evidencia confirmada |
| «Reading is taking longer than expected. Reload the page to check again.» | Recarga |
| «Failed: …» en un PDF | Descarta y vuelve a subir |
| Errores de tamaño, de caracteres o de cantidad | Ver [Casos y evidencias](cases-and-evidence.md#errores) y [Revisión de PDF](pdf-review.md#mensajes-y-bloqueos) |
| «A response that attaches or quotes this upload is being sent to PayPal right now; delete it once the outcome is known» | Espera a que termine el envío |
| «The analyses that quote this upload could not be removed, so it was not deleted; try again» | Inténtalo de nuevo |

## Revisar y enviar

| Ves | Solución |
|---|---|
| **Review what will be sent →** desactivado | Lee la barra de encima: resuelve cada punto de la lista |
| «only "Provide evidence" can be sent from this screen for now» | Elige **Provide evidence** en **What to do** |
| «Nothing can be sent yet» con motivos | Corrige los motivos, **← Back to edit**, **Try again** |
| «Only the seller's workspace can send this» | Inicia sesión en el espacio del vendedor |
| «What would be sent now differs from what you approved…» (`INTENT_STALE`) | Revisa de nuevo y aprueba |
| «The approval was not recorded, so nothing was sent: …» | Inténtalo de nuevo |
| «The send could not be recorded durably, so nothing was sent; try again later» (`AUDIT_UNAVAILABLE`) | Inténtalo más tarde |
| «PayPal already has seller evidence for this dispute; nothing more can be sent» | Lee la evidencia registrada |
| **Submission not confirmed** | **Try again**: ResolveKit relee primero y solo reenvía si PayPal no muestra nada registrado |
| «New seller evidence that doesn't match what we sent» | Otra persona envió evidencia; no se reintenta nada. Revisa «Sent versus recorded» |
| «The PayPal connection changed while you were reviewing. Close this and open the case again.» | Cierra y vuelve a abrir el caso |

## Agente comprador

| Ves | Solución |
|---|---|
| **Start the run** desactivado | Escribe un objetivo y un tope; espera a que termine tu ejecución en curso |
| No aparece el enlace **Approve in PayPal** | Solo lo ve el autor, y solo mientras la ejecución espera la aprobación |
| PayPal rechaza el inicio de sesión o el pago | Usa una cuenta **personal (compradora)** de sandbox, no la cuenta business (PayPal rechazó la cuenta business del vendedor en la ejecución en sandbox del 19/10/2026; observado, no documentado) |
| «Stopped: PayPal approval timed out» | Aprueba en 15 minutos; inicia una ejecución nueva |
| «Not verified yet» | El servidor concilia el recibo cada 5 minutos; la página sigue comprobando durante 30 minutos |
| «Interrupted (stopped or server restart)» | Se pulsó Stop o el servidor se reinició; una llamada en curso muestra **uncertain** y nunca se repite |
| Otros rechazos | Ver [Agente comprador](buying-agent.md#errores) |

## Límites y servicio

| Ves | Solución |
|---|---|
| 429 `RATE_LIMITED` | Demasiadas peticiones desde tu dirección; espera el tiempo indicado (`Retry-After`) |
| 429 `DAILY_CAP` / `PERSON_CAP` | Se ha agotado un límite diario compartido; se restablece a medianoche UTC |
| 503 `CAPS_UNAVAILABLE` «The demo cannot record this action's use right now, so it is not done» | Inténtalo más tarde |
| Errores (502) durante 1–2 minutos | El servicio se está redesplegando; espera y recarga |
| «The server could not be reached.» | Comprueba tu conexión; puede que el servicio se esté reiniciando |

¿Sigues atascado? Infórmalo como se describe en [CONTRIBUTING.es.md](../../../CONTRIBUTING.es.md); nunca incluyas enlaces
de invitación, tokens ni datos personales.
