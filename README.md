# AFIP/ARCA Facturación API

API REST para facturación electrónica con AFIP/ARCA Argentina (Facturas, NC y ND A/B/C).

---

> **Nota:** App de uso personal. Funciona para **Facturas A/B/C** y **notas de crédito/débito**. Uso gratuito; si hay un problema, abrí un **Issue**.

---

## Instalación

```bash
git clone <repo>
cd afip_app
npm install
cp env.example .env
```

En `.env`:

```env
AFIP_CUIT=20123456789      # default si el pedido no manda cuit
AFIP_PTO_VTA=1             # default si el pedido no manda ptoVta
PORT=5001
# AFIP_API_SECRET=opcional  # si está, exige header X-Afip-Secret
```

Certificados del emisor (no van al repo) en `src/servicios/certs/`:

```
key.key
cert.crt
```

> Guía: [CERTIFICADOS.md](CERTIFICADOS.md). En ARCA hay que autorizar el **computador fiscal** del servidor; si no, WSAA rechaza.

```bash
npm start
# producción:
pm2 start app.js --name "afip-api"
```

---

## Endpoints

| Método | Ruta | Uso |
|--------|------|-----|
| `GET` | `/afip/tipos` | Tipos de comprobante soportados |
| `POST` | `/afip/siguiente` | Próximo número (último + 1) |
| `POST` | `/afip/emitir` | Emitir factura / NC / ND |
| `POST` | `/afip/comprobante` | Consultar CAE (evita doble factura) |
| `POST` | `/afip/ticket` | Compat: emitir con validación clásica |
| `POST` | `/afip/ticket-test` | Prueba $100 Factura B CF |
| `GET` | `/afip/contribuyente?cuit=` | Padrón |
| `GET` | `/afip/condicion-iva?clase=` | Condiciones IVA (`A`/`B`/`C`) |

En casi todos los POST van `cuit` y `ptoVta` en el body (si faltan, usa el `.env`).

---

### `POST /afip/emitir`

Factura B consumidor final (recargas):

```json
{
  "cuit": "20123456789",
  "ptoVta": 1,
  "monto": 1210,
  "tipfac": 6,
  "doctipo": 99,
  "docnro": 0
}
```

Nota de crédito B (asocia la factura original):

```json
{
  "cuit": "20123456789",
  "ptoVta": 1,
  "tipfac": 8,
  "monto": 1210,
  "doctipo": 99,
  "asociado": { "nro": 123, "tipfac": 6, "ptoVta": 1 }
}
```

También sirve `cbtesAsoc: [{ "tipo": 6, "ptoVta": 1, "nro": 123 }]`.

**Response:**

```json
{
  "success": true,
  "data": {
    "CAE": "74123456789012",
    "CAEFchVto": "20240125",
    "voucherNumber": 1234,
    "montoTotal": 1210,
    "montoNeto": 1000,
    "montoIVA": 210,
    "CondicionIVAReceptorId": 5
  }
}
```

Si ARCA rechaza: `{ "success": false, "error": "...", "code": 10242 }`.

---

### `POST /afip/siguiente`

```json
{ "cuit": "20123456789", "ptoVta": 1, "tipfac": 6 }
```

### `POST /afip/comprobante`

```json
{ "cuit": "20123456789", "ptoVta": 1, "tipfac": 6, "nro": 1234 }
```

### `POST /afip/ticket`

Igual que antes (`doctipo`, `docnro`, `monto`, `tipfac`) + `cuit`/`ptoVta` y, si es NC/ND, `asociado`.

---

## Tipos de comprobante (`tipfac`)

| Código | Tipo |
|--------|------|
| 1 / 2 / 3 | Factura / ND / NC **A** |
| 6 / 7 / 8 | Factura / ND / NC **B** |
| 11 / 12 / 13 | Factura / ND / NC **C** |

NC/ND **obligan** comprobante asociado. Factura C se arma sin discriminación de IVA.

Condición IVA por defecto: clase A → `1`; B/C consumidor final (`doctipo` 99) → `5`.

## Tipos de documento

| Código | Tipo |
|--------|------|
| 80 | CUIT |
| 86 | CUIL |
| 96 | DNI |
| 99 | Consumidor Final |

---

## Ejemplos

```bash
# Factura B CF
curl -X POST http://localhost:5001/afip/emitir \
  -H "Content-Type: application/json" \
  -d '{"cuit":"20123456789","ptoVta":1,"monto":1210,"tipfac":6,"doctipo":99,"docnro":0}'

# Nota de crédito B
curl -X POST http://localhost:5001/afip/emitir \
  -H "Content-Type: application/json" \
  -d '{"cuit":"20123456789","ptoVta":1,"monto":1210,"tipfac":8,"doctipo":99,"asociado":{"nro":123,"tipfac":6}}'

# Consultar si ya salió el CAE
curl -X POST http://localhost:5001/afip/comprobante \
  -H "Content-Type: application/json" \
  -d '{"cuit":"20123456789","ptoVta":1,"tipfac":6,"nro":1234}'
```

Con secret: `-H "X-Afip-Secret: tu-secreto"`.

---

## Licencia

MIT
