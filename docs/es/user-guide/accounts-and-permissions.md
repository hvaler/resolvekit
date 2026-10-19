[English](../../user-guide/accounts-and-permissions.md) | [Español](accounts-and-permissions.md)

# Cuentas y permisos

Cada comerciante tiene su propio espacio de trabajo. Solo el espacio de trabajo cuya cuenta de PayPal es el
**vendedor** de una disputa de sandbox vinculada ve y responde esa disputa. Esta página trata el inicio de sesión, los
roles, las invitaciones, el cierre de sesión y lo que se conserva. La matriz completa de permisos está en la
[Especificación funcional](../product/functional-specification.md#3-permisos).

Estado: Implementado · Probado en local · Desplegado. Inicio de sesión con PayPal: Verificado en sandbox. Creación de
passkey en el servicio de sandbox desplegado: **Pendiente** (aún sin evidencia). El modo local no tiene cuentas.

## Formas de iniciar sesión

| Forma | Para | Qué ocurre |
|---|---|---|
| **Continue with PayPal** | Comerciantes (pasa a ser el **Owner**) | Apruebas una solicitud sin cargo en PayPal para que ResolveKit pueda confirmar qué cuenta es la tuya. «No money moves and no agreement is created.» |
| **Sign in with a passkey** | Miembros que se unieron con una passkey | La passkey de tu dispositivo (WebAuthn) vuelve a iniciar tu sesión |
| Un enlace de invitación | Nuevos miembros y revisores | Abre **Join**: «<workspace> invited you as a member / reviewer» |

**Continue with PayPal** es una comprobación de identidad, no Log in with PayPal: ResolveKit crea un agreement token de
Billing Agreements sin cargo con una app de «identidad» aparte (una familia de APIs de PayPal que figura bajo una ruta
obsoleta) y, una vez que lo apruebas, lee qué cuenta de PayPal lo aprobó. No se crea ningún acuerdo y no se cobra nada.
Iniciar sesión **no** da a ResolveKit acceso a tus disputas.

Tras iniciar sesión con PayPal llegas a la página de inicio. Si el inicio de sesión con PayPal falla, `/signin` muestra
el motivo:

| Mensaje | Significado |
|---|---|
| «You cancelled on PayPal. Nothing was shared.» | Cancelaste |
| «PayPal did not confirm the approval. Try again.» | El token no se aprobó |
| «That sign-in was started in another browser or has expired. Start again here.» | El inicio de sesión debe terminar en el navegador que lo empezó, en 15 minutos |
| «PayPal could not be reached. Try again in a moment.» | PayPal no disponible |
| «PayPal sign-in is not set up on this server.» | No configurado (p. ej. modo local) |
| «Your account could not be saved. Try again later.» | Problema de almacenamiento en el servidor |
| «This demo has reached its number of workspaces.» | La demo está llena |

## Roles

| Etiqueta de rol | Quién | Puede | No puede |
|---|---|---|---|
| **Owner** | La cuenta de PayPal que inició sesión | Todo en el espacio de trabajo; **Members and invites**; **Workspace runs** y **Keep** en `/agent` | Ser revocado |
| **Member** | Se unió con una invitación de miembro | Revisar casos, añadir evidencia, revisar y borrar cualquier subida, aprobar y enviar respuestas, ejecutar el agente, dentro de los límites diarios | Conectar PayPal; gestionar miembros |
| **Reviewer** | Se unió con una invitación de revisor (jurados) | Lo mismo que un Member, hasta la fecha de fin de acceso | Editar o descartar subidas pendientes de otras personas; borrar subidas; gestionar miembros |

Lo que aprueba cada persona lleva su nombre y su rol en el registro de auditoría, p. ej. «Dana Ruiz (Member, reviewer ·
passkey) p_…» (nombre, rol, cómo se unió, id de persona).

Una aprobación pertenece a la persona que la compuso: nadie más, ni siquiera el Owner, puede aprobar o enviar una
respuesta compuesta por otra persona.

## Invitar a personas (Owner)

1. Abre el menú de la cuenta → **Members and invites** (o `/workspace`). Solo lo ve el Owner (si no, «Owners only»).
2. Rellena el formulario: **Label**, **Uses** (1–300), **Link valid (days)** (1–120), **Reviewer** (márcalo para un
   enlace de revisor con tiempo limitado), **Access until** (solo revisor; como máximo 180 días a partir de hoy).
3. **Create invite link**. «Copy this link now: it is shown only once.» → **Copy link**.
4. Envía el enlace en privado. Cualquiera que lo tenga puede unirse hasta que se agoten sus usos, caduque o se revoque.

El token de invitación viaja en el fragmento `#` del enlace y se quita de la barra de direcciones al abrir la página.

Invitar a alguien no conecta tus disputas a PayPal: un espacio de trabajo que no es el vendedor de sandbox sigue
mostrando la pantalla de espera a todos los que están en él.

## Unirse a un espacio de trabajo

1. Abre el enlace de invitación. «Checking the invite…».
2. Escribe **Your name, as the audit trail will show it** (1–60 caracteres).
3. **Create a passkey and join**, o **Join for this browser only**. «A passkey lets you sign in again on this device.
   "This browser only" ends when the session does (12 hours).»

| Página de invitación | Qué hacer |
|---|---|
| «This invite was already used» / «This invite has expired» / «This invite was revoked» | «Ask the workspace owner for a new link.» |
| «This page needs the full invite link.» | Abre el enlace completo, incluida la parte tras `#` |
| «The passkey was not created (cancelled or timed out).» | Inténtalo de nuevo, o **Join for this browser only** |

Unirse otra vez con un enlace que aún tiene usos crea una nueva entrada de miembro; no restaura la antigua.

## Gestionar miembros (Owner)

**Members** muestra **Name**, **Role**, **Joined with** (PayPal, passkey, this browser only), **Last active (UTC)**.
**Revoke** termina el acceso de esa persona de inmediato (todas sus sesiones). **Invite links** muestra cada enlace con
sus usos, su caducidad y **Revoke**. Las personas y enlaces revocados siguen en la lista como «Revoked».

## Sesiones y cierre de sesión

| Control | Efecto |
|---|---|
| **Sign out** | Termina la sesión en este navegador |
| **Sign out of all devices** | Termina a la vez todas tus sesiones |
| **Use another PayPal account** | Cierra la sesión y abre un inicio de sesión de PayPal nuevo |

Una sesión dura 12 horas. El acceso de un revisor termina en su fecha **Access until** («Reviewer access until
<date>»).

## El menú de la cuenta

Tu nombre, «<role> of <workspace> · signed in with <PayPal | passkey | this browser only>», tu correo cuando PayPal lo
facilitó, y la conexión del espacio de trabajo:

- «Sandbox evaluation: this workspace's PayPal account is the seller on the bound sandbox disputes. Test documents go
  to PayPal sandbox disputes; no real money moves.»
- «This workspace isn't connected to its PayPal disputes yet. Explore demo shows the full flow on fictional cases.»
- «Checking this workspace's PayPal connection…»

## Qué se guarda sobre ti y qué se puede borrar

| Dato | Dónde | Se conserva | Puedes |
|---|---|---|---|
| Tu registro de persona (nombre, rol, cómo te uniste, última actividad; correo en los inicios de sesión con PayPal) | Servidor de ResolveKit | Sin caducidad en el código | El Owner puede pulsar **Revoke** (el registro se queda, marcado como revocado). Sin borrado autoservicio |
| Clave pública de la passkey | Servidor de ResolveKit | Con tu registro | — |
| Cookie de sesión | Tu navegador | 12 horas | **Sign out** |
| Borradores (ediciones, resoluciones) | El almacenamiento de tu navegador, por persona | Hasta que se borre | Borra los datos del sitio en tu navegador |
| Eventos de auditoría que te nombran | Servidor de ResolveKit | Los últimos 200 por persona; el registro de envíos nunca se purga | — |
| Tu cuenta de PayPal | PayPal | Según la política de PayPal | ResolveKit no creó ningún acuerdo que eliminar |

Borrar cuentas o espacios de trabajo no está disponible (ver [Limitaciones](../product/limitations.md)). Para la
retención de datos en el servidor, ver [Retención y borrado](../operations/retention-and-deletion.md).
