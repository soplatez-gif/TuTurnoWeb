# TuTurno · API del motor de la app

Estructura de endpoints sobre el esquema `backend/schema.sql`. Las reglas vienen
de los TyC Colombia v2.3 y del Manual de Implementación TyC v1.3; cada ruta cita
la cláusula que la origina.

## Convenciones

- **Base:** `/v1`. JSON en ambos sentidos. Montos en pesos enteros (`amount_cop`).
- **Autenticación:** JWT de Supabase Auth (`Authorization: Bearer …`). Las
  rutas corren con `service_role` y filtran siempre por el `user_id` del token.
- **Rutas sensibles** (cambiar medios de pago, retirar comisión): exigen un
  `otp_challenge_id` vigente con propósito `payout_change` (2FA, auditoría §3).
- **Idempotencia:** los `POST` que crean cobros u órdenes aceptan
  `Idempotency-Key`.
- **Errores:** `{ "error": { "code": "chain_full", "message": "…" } }`. Los
  mensajes al usuario siguen el glosario de Colombia: nunca "san", "préstamo",
  "crédito", "intereses", "inversión", "ganar" ni "banco".
- **Implementación sugerida:** Supabase Edge Functions (Deno), una función por
  grupo (`auth`, `me`, `chains`, `payments`, `webhooks`, `admin`) y tareas
  programadas con `pg_cron`.

## 1. Cuenta y verificación

| Método | Ruta | Qué hace | Tablas |
|---|---|---|---|
| POST | `/auth/otp` | Envía un código por SMS o WhatsApp (login, cambio de pago, respaldo) | `otp_challenges` |
| POST | `/auth/otp/verify` | Valida el código (máx. 5 intentos) | `otp_challenges` |
| GET | `/me` | Perfil, estado de la cuenta y de la verificación | `profiles`, `kyc_verifications` |
| PATCH | `/me` | Actualiza nombre, correo y teléfono | `profiles` |
| POST | `/me/kyc` | Inicia la verificación de identidad. Exige la casilla B vigente (Manual §3.6) | `kyc_verifications`, `consent_records` |
| GET | `/me/kyc` | Estado de la verificación | `kyc_verifications` |
| GET | `/me/payout-methods` | Llaves Bre-B y cuentas para recibir | `payout_methods` |
| POST | `/me/payout-methods` | Agrega una llave o cuenta a nombre del usuario (cl. 3). 2FA | `payout_methods` |
| PATCH | `/me/payout-methods/:id` | La marca por defecto o la desactiva. 2FA | `payout_methods` |
| GET | `/me/credits` | Créditos de comisión disponibles (cl. 4.4 b) | `user_credits` |

## 2. Términos y aceptación (Manual §2-§5)

| Método | Ruta | Qué hace | Tablas |
|---|---|---|---|
| GET | `/legal/current?country=CO` | Generales + país vigentes: Markdown, versión y SHA-256 | `legal_documents` |
| POST | `/legal/consents` | Registra A, B y C en una sola llamada al tocar **"Acepto"**. Guarda IP, dispositivo, versiones, hashes, texto exacto y, en la C, la cadena y la frecuencia. Si falla, la app no avanza (§3.8) | `consent_records` |
| GET | `/me/consents` | Historial de aceptaciones (Ajustes) | `consent_records` |

## 3. Cadenas

| Método | Ruta | Qué hace | Tablas |
|---|---|---|---|
| GET | `/chain-products` | Cadenas disponibles: cuota, total, frecuencias, comisión | `chain_products` |
| GET | `/chain-products/:id/availability?frequency=weekly` | ¿Hay cadena formándose con esa frecuencia? Si no, mensaje claro (bug "no hay cadenas disponibles") | `chains` |
| POST | `/chains/join` | `{ product_id, frequency, consent_c_id }`. Busca una cadena `forming` o crea una, inscribe al usuario como `pending_commission` y crea la comisión. Rechaza si está en mora (cl. 7) | `chains`, `chain_members`, `commissions` |
| GET | `/me/chains` | Mis cadenas: cuánto pongo, cuánto recibo, mi fecha y cupos llenos | vista `my_chain_summary` |
| GET | `/chains/:id` | Detalle: participantes, ciclos y estado de cada cuota | `chains`, `chain_members`, `cycles`, `installments` |
| GET | `/chains/:id/payout-methods` | Llaves de los participantes (solo de la propia cadena, cl. 8) | vista `payout_methods_shared` |
| POST | `/chains/:id/withdraw` | Retiro voluntario. Si está dentro de 5 días hábiles y la cadena no arrancó, reembolsa la comisión (cl. 4.4 a) | `chain_members`, `commission_refunds` |
| POST | `/chains/:id/turn-review` | Pide revisión humana del turno asignado | `turn_review_requests` |
| POST | `/chains/:id/guarantor` | Registra un respaldo y le envía el código (cl. 5.5, Manual §4.3) | `guarantors`, `otp_challenges` |
| POST | `/guarantors/:id/confirm` | El respaldo ingresa el código | `guarantors`, `otp_challenges` |

## 4. Comisión de servicio (cl. 4)

| Método | Ruta | Qué hace | Tablas |
|---|---|---|---|
| POST | `/commissions/:id/checkout` | Crea el PaymentIntent de Stripe (tarjeta) por la comisión, o la paga con un crédito | `commissions`, `user_credits` |
| GET | `/commissions/:id` | Estado y, si falló, el motivo del rechazo | `commissions` |
| POST | `/webhooks/stripe` | `payment_intent.succeeded` → comisión `paid` y miembro a `pending_kyc`/`active`. `payment_intent.payment_failed` → guarda `stripe_failure_code`. `charge.refunded` → cierra el reembolso. Firma verificada | `commissions`, `chain_members`, `commission_refunds` |

## 5. Cuotas entre participantes (cl. 3 y 10)

TuTurno no recibe esta plata: la ruta solo muestra a quién pagar y registra el
comprobante.

| Método | Ruta | Qué hace | Tablas |
|---|---|---|---|
| GET | `/me/installments?status=pending` | Mis cuotas por pagar y por recibir, con fecha de corte | `installments`, `cycles` |
| POST | `/installments/:id/payment-order` | Genera la orden de pago (vence en 10 minutos; si vence, sale otra y no es mora) | `payment_orders` |
| POST | `/installments/:id/proofs` | Sube el comprobante (Supabase Storage, bucket privado) → `proof_uploaded` | `payment_proofs`, `installments` |
| POST | `/installments/:id/confirm` | El receptor confirma que le llegó → `confirmed` | `installments` |
| POST | `/installments/:id/dispute` | El receptor dice que no le llegó → pasa a soporte | `installments`, `support_tickets` |

## 6. Mora y garantía (cl. 1.4, 1.5, 3.5 y 7)

| Método | Ruta | Qué hace | Tablas |
|---|---|---|---|
| GET | `/me/delinquencies` | Lo que debo: cuota cubierta + recargo único del 12,5 %, y hasta cuándo va la gracia | `delinquencies` |
| POST | `/delinquencies/:id/payment-order` | Orden para pagarle a TuTurno lo cubierto + recargo | `delinquencies` |

## 7. Atención y datos personales

| Método | Ruta | Qué hace | Tablas |
|---|---|---|---|
| POST | `/support/tickets` | Crea una PQR con vencimiento a 15 días hábiles | `support_tickets` |
| GET | `/support/tickets` | Mis PQR | `support_tickets` |
| POST | `/me/data-requests` | Consulta, corrección, revocatoria o **eliminar cuenta** (Ley 1581) | `data_requests` |
| GET | `/me/notifications` | Avisos y recordatorios | `notifications` |

## 8. Administración (rol `admin`, panel interno)

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/admin/chains?status=forming` | Cadenas por estado y cupos |
| POST | `/admin/proofs/:id/review` | Aprueba o rechaza un comprobante |
| GET | `/admin/coverages?status=open` | Coberturas abiertas y su plazo de 5 días hábiles |
| POST | `/admin/coverages/:id/allocations` | Registra de dónde salió la plata: comisión nueva → pago del moroso → recursos propios |
| POST | `/admin/delinquencies/:id/contacts` | Registra un contacto de cobranza (la base rechaza horarios no permitidos) |
| POST | `/admin/delinquencies/:id/bureau-notice` | Envía el aviso previo de 20 días |
| POST | `/admin/turn-reviews/:id/resolve` | Resuelve una revisión de turno |
| PUT | `/admin/legal-documents` | Publica una nueva versión de términos (Markdown + SHA-256) |

## 9. Tareas programadas (`pg_cron` o Edge Functions con cron)

| Cuándo | Tarea | Regla |
|---|---|---|
| Cada minuto | Vence órdenes de pago abiertas con más de 10 minutos | cl. 10 |
| Cada hora | Cierra cadenas `forming` vencidas (10 días): `cancelled_unfilled` y reembolso o crédito | cl. 4.4 b |
| Al llenarse una cadena | Asigna turnos por evaluación de riesgo, crea los 5 ciclos y las 20 cuotas | cl. "La cadena" |
| 12:00 a. m. Bogotá | Cuotas sin confirmar tras el corte → `overdue`; abre la cobertura (corte + 5 días hábiles) y la mora (gracia de 6 días) | cl. 3.5 y 7 |
| Diario | Mora que supera la gracia → `collection`. Coberturas cerca del plazo → alerta interna | cl. 7 |
| Diario | Recordatorios: cuota próxima a vencer y "mañana es tu turno" | cl. 13.3 |

## Flujo principal de la app

```
Elegir cadena y frecuencia ─► GET /chain-products/:id/availability
Pantalla de términos ───────► GET /legal/current → POST /legal/consents (A, B, C)
Entrar a la cadena ─────────► POST /chains/join
Pagar la comisión ──────────► POST /commissions/:id/checkout → Stripe → /webhooks/stripe
Verificar identidad ────────► POST /me/kyc
Esperar que se llene ───────► GET /me/chains (cupos 2 de 5…)
Pagar cada cuota ───────────► POST /installments/:id/payment-order → /proofs
Recibir el turno ───────────► POST /installments/:id/confirm (4 cuotas de los demás + la propia = 5)
```
