# AFIP/ARCA Facturación API

API REST para facturación electrónica con AFIP/ARCA Argentina.

---

> **Nota:** Esta es una aplicación que desarrollé hace tiempo para mi uso personal. La documentación fue generada con ayuda de IA. La aplicación funciona correctamente y la utilizo activamente en mi negocio para generar **Facturas A y B**.
>
> El uso es **completamente gratuito**. Si encuentran algún problema o quieren que agregue alguna funcionalidad, simplemente creen un **Issue** y lo reviso.
>
> ¡Gracias por usar esta herramienta!

---

## Instalación

```bash
git clone <repo>
cd afip-facturacion-api
npm install
```

## Configuración

```bash
cp env.example .env
```

Editar `.env`:

```env
AFIP_CUIT=20123456789      # Tu CUIT (11 dígitos)
AFIP_PTO_VTA=1             # Punto de venta habilitado
PORT=5001                  # Puerto (opcional)
```

## Certificados

Colocar en `src/servicios/certs/`:

```
src/servicios/certs/
├── key.key    # Clave privada
└── cert.crt   # Certificado
```

> 📄 **[Ver guía completa de certificados ARCA](CERTIFICADOS.md)** - Paso a paso para obtener tu certificado

## Ejecutar

```bash
npm start
# o en desarrollo:
npm run dev
```

---

## API

### `POST /afip/ticket`

Genera factura electrónica.

**Request:**

```json
{
  "doctipo": 99,
  "docnro": 0,
  "monto": 1210,
  "tipfac": 6
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `doctipo` | int | Tipo documento: `80`=CUIT, `86`=CUIL, `96`=DNI, `99`=Consumidor Final |
| `docnro` | int | Número de documento (0 para consumidor final) |
| `monto` | number | Monto total con IVA incluido |
| `tipfac` | int | Tipo factura: `1`=Factura A, `6`=Factura B |

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
    "montoIVA": 210
  }
}
```

---

### `POST /afip/ticket-test`

Genera factura de prueba ($100, Factura B, Consumidor Final).

**Request:** ninguno

**Response:** igual que `/afip/ticket`

---

### `GET /afip/contribuyente?cuit=XX`

Consulta datos de contribuyente en padrón AFIP.

**Response:**

```json
{
  "success": true,
  "data": {
    "razonSocial": "EMPRESA SA",
    "cuit": "20123456789",
    "tipoPersona": "JURIDICA",
    "condicionIVA": "Resp. Inscripto",
    "tipoFactura": 1,
    "domicilio": "Av. Corrientes 1234",
    "localidad": "CABA",
    "provincia": "CIUDAD AUTONOMA BUENOS AIRES",
    "codigoPostal": "1043"
  }
}
```

---

### `GET /afip/condicion-iva`

Lista condiciones IVA disponibles.

**Query params:** `?clase=A` o `?clase=B` (opcional)

---

## Ejemplos

### Factura B - Consumidor Final

```bash
curl -X POST http://localhost:5001/afip/ticket \
  -H "Content-Type: application/json" \
  -d '{"doctipo":99,"docnro":0,"monto":1210,"tipfac":6}'
```

### Factura A - Responsable Inscripto

```bash
curl -X POST http://localhost:5001/afip/ticket \
  -H "Content-Type: application/json" \
  -d '{"doctipo":80,"docnro":20123456789,"monto":1210,"tipfac":1}'
```

### Consultar CUIT

```bash
curl "http://localhost:5001/afip/contribuyente?cuit=20123456789"
```

---

## Tipos de Documento

| Código | Tipo |
|--------|------|
| 80 | CUIT |
| 86 | CUIL |
| 96 | DNI |
| 99 | Consumidor Final |

## Tipos de Factura

| Código | Tipo | Receptor |
|--------|------|----------|
| 1 | Factura A | Resp. Inscripto |
| 6 | Factura B | Consumidor Final / Monotributo / Exento |

---

## Certificados AFIP

1. Ingresar a [AFIP](https://auth.afip.gob.ar/contribuyente_/)
2. Ir a **Administrador de Relaciones de Clave Fiscal**
3. Agregar servicio **WSFE - Factura Electrónica**
4. Generar CSR y descargar certificado

---

## Producción

```bash
npm install -g pm2
pm2 start app.js --name "afip-api"
```

## Licencia

MIT
