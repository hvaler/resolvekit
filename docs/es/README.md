[English](../README.md) | [Español](README.md)

# Documentación de ResolveKit

Empieza por tu papel. Todas las páginas usan las mismas palabras de estado: Diseñado · Implementado · Probado en local ·
Verificado en sandbox · Desplegado · Disponible para usuarios · Pendiente. La presentación del proyecto es el
[README](../../README.es.md).

## Jurado y revisores

| Página | Qué responde |
|---|---|
| [Guía de revisión](judges/review-guide.md) | Qué mirar en unos 5 minutos, qué es real, cómo entrar, qué hacer si un caso ya se usó |
| [Recorrido por la demo](judges/demo-walkthrough.md) | Cada paso con los nombres exactos de los controles |
| [Matriz de verificación](judges/verification-matrix.md) | Cada afirmación pública, su evidencia y su estado, con las afirmaciones sin respaldo marcadas |

## Comerciantes y usuarios

| Página | Qué responde |
|---|---|
| [Visión general del producto](product/overview.md) | Qué hace ResolveKit y para quién |
| [Primeros pasos](user-guide/getting-started.md) | Los tres entornos y cómo entrar en cada uno |
| [Casos y evidencias](user-guide/cases-and-evidence.md) | El expediente, las citas, las contradicciones, añadir tu propia evidencia |
| [Revisión de PDF](user-guide/pdf-review.md) | Elegir páginas, tapar, volver a leer, transcribir |
| [Revisar y enviar](user-guide/review-and-submit.md) | Aprobar el contenido exacto, enviar, releer |
| [Agente comprador](user-guide/buying-agent.md) | Objetivos, presupuestos, aprobación en PayPal, recibos, Compare y Keep |
| [Cuentas y permisos](user-guide/accounts-and-permissions.md) | Continue with PayPal, invitaciones, passkeys, roles |
| [Solución de problemas](user-guide/troubleshooting.md) | Mensajes que puedes ver y qué hacer |
| [Limitaciones](product/limitations.md) | Qué no funciona o todavía no está disponible |
| [Especificación funcional](product/functional-specification.md) | El comportamiento en detalle, pantalla a pantalla |

## Desarrolladores

| Página | Qué responde |
|---|---|
| [Desarrollo local](technical/local-development.md) | Instalar, ejecutar, probar |
| [Configuración](technical/configuration.md) | Cada variable de entorno |
| [API HTTP](technical/http-api.md) | Rutas, protecciones, errores |
| [Herramientas MCP](technical/mcp-tools.md) | Las herramientas de MeterMCP, sus precios, las rutas de administración |
| [Integración con PayPal](technical/paypal-integration.md) | Endpoints a los que se llama, qué está documentado, qué solo se observó en el sandbox |
| [Alta de comerciantes](technical/merchant-onboarding.md) | Estado de la conexión de las disputas propias de los comerciantes (Pendiente) |
| [Pipeline de IA](technical/ai-pipeline.md) | Pasos del analista y comprobaciones deterministas |
| [Agente comprador](technical/buying-agent.md) | Motor, validación, límites, liquidación |
| [Procesamiento de evidencia](technical/evidence-processing.md) | Imágenes, PDF, OCR, archivos saneados |
| [Visión general de la arquitectura](architecture/overview.md) · [Componentes](architecture/components.md) · [Datos y almacenamiento](architecture/data-and-storage.md) · [Fronteras de confianza](architecture/trust-boundaries.md) | Cómo encajan las piezas y dónde termina la confianza |
| [Contribuir](../../CONTRIBUTING.es.md) | Cómo proponer cambios |

## Operadores

| Página | Qué responde |
|---|---|
| [Despliegue](operations/deployment.md) | Render Blueprint, secretos, orden de los despliegues |
| [Runbook](operations/runbook.md) | `demo:check`, `demo:prepare`, reservas, límites |
| [Copias de seguridad y recuperación](operations/backup-and-recovery.md) | Qué existe (y qué no) |
| [Retención y borrado](operations/retention-and-deletion.md) | Cuánto tiempo se guarda cada tipo de dato |

## Calidad y seguridad

| Página | Qué responde |
|---|---|
| [Tests](quality/testing.md) | Las suites de tests y la última ejecución fechada |
| [Evaluaciones](quality/evaluations.md) | Evaluaciones del analista en conjuntos sintéticos: la única fuente de cifras de evaluación |
| [Seguridad y privacidad](quality/security-and-privacy.md) | Medidas y sus límites |
| [Problemas conocidos](quality/known-issues.md) | Tareas pendientes abiertas |
| [Política de seguridad](../../SECURITY.es.md) | Cómo informar de una vulnerabilidad |

## Páginas antiguas

Estas direcciones siguen funcionando y remiten a las páginas nuevas: [judges.md](judges.md) → guía de revisión,
[evals.md](evals.md) → evaluaciones, [sandbox-findings.md](sandbox-findings.md) → integración con PayPal.
Capturas de pantalla y sus pies: [media](../media/README.md).
