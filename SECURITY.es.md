[English](SECURITY.md) | [Español](SECURITY.es.md)

# Política de seguridad

ResolveKit es un proyecto de hackathon: una demo pública sobre el **sandbox** de PayPal (sin dinero real), no un
servicio de producción. No se usa ningún entorno live de PayPal.

## Informar de una vulnerabilidad

**Todavía no hay un canal de seguridad dedicado** (ni correo de seguridad ni programa de recompensas). No está
confirmado que el informe privado de vulnerabilidades de GitHub esté activado para este repositorio (**Pendiente**).

Hasta que exista uno:

1. **No abras una issue pública con detalles** de una vulnerabilidad, y no incluyas código de explotación, tokens,
   enlaces de invitación ni datos personales en ningún lugar público.
2. Contacta con el propietario del repositorio a través de su perfil de GitHub (el propietario de este repositorio en
   GitHub) y pide un canal privado. Comparte los detalles solo cuando se haya acordado uno.
3. Explica qué encontraste, cómo reproducirlo contra la demo en sandbox o una ejecución local, y a qué afecta.

Acusaremos recibo de lo que podamos, en cuanto podamos; no prometemos plazos de respuesta. Prueba solo contra tu propia
ejecución local o contra la demo pública dentro de sus límites: no envíes evidencia a disputas que no sean tuyas, no
intentes agotar los topes diarios compartidos y no uses cuentas reales de PayPal ni datos reales de clientes.

## Alcance

Dentro del alcance: el código de este repositorio (`apps/server`, `apps/metermcp`, `apps/web`, `packages/*`) y la demo
alojada construida a partir de él. Fuera del alcance: PayPal, Google Gemini, Groq y Render en sí (infórmales a ellos), y
los hallazgos que requieran una máquina del operador o una cuenta de Render comprometidas.

## Qué leer primero

- [Seguridad y privacidad](docs/es/quality/security-and-privacy.md): los controles, sus tests y los riesgos residuales.
- [Fronteras de confianza](docs/es/architecture/trust-boundaries.md): en qué se confía y dónde.
- [Problemas conocidos](docs/es/quality/known-issues.md): puntos abiertos ya conocidos.

## Versiones con soporte

Solo la rama `main` actual. No hay releases ni backports.
