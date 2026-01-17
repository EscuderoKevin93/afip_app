# Guía de Certificados ARCA/AFIP

Para usar esta API necesitás obtener un **certificado digital** y su correspondiente **key** de ARCA (ex AFIP).

> **Créditos:** Esta documentación fue tomada de [Afip SDK](https://afipsdk.com). Gracias por hacer esta guía pública y accesible para la comunidad.
>
> Si los autores de Afip SDK necesitan que remueva esta documentación, no hay problema, simplemente contactenme y la elimino.

---

## ¿Qué necesito?

1. **Clave Fiscal Nivel 3** en ARCA
2. **Certificado digital** (archivo `.crt`)
3. **Clave privada** (archivo `.key`)
4. **Autorización del web service** de facturación electrónica

---

## Paso a Paso

### 1. Habilitar el Administrador de Certificados

Primero debés habilitar el servicio en tu escritorio de ARCA:

| Ambiente | Guía |
|----------|------|
| Testing/Desarrollo | [Habilitar administrador de certificados de testing](https://docs.afipsdk.com/recursos/tutoriales-pagina-de-arca/habilitar-administrador-de-certificados-de-testing) |
| Producción | [Habilitar administrador de certificados de producción](https://docs.afipsdk.com/recursos/tutoriales-pagina-de-arca/habilitar-administrador-de-certificados-de-produccion) |

### 2. Obtener el Certificado

Generá tu certificado digital siguiendo estas guías:

| Ambiente | Guía |
|----------|------|
| Testing/Desarrollo | [Obtener certificado de testing](https://docs.afipsdk.com/recursos/tutoriales-pagina-de-arca/obtener-certificado-de-testing) |
| Producción | [Obtener certificado de producción](https://docs.afipsdk.com/recursos/tutoriales-pagina-de-arca/obtener-certificado-de-produccion) |

#### Comandos OpenSSL

```bash
# Generar clave privada (key)
openssl genrsa -out key.key 2048

# Generar CSR (reemplazar los datos)
openssl req -new -key key.key -subj "/C=AR/O=TU_EMPRESA/CN=MiCertificado/serialNumber=CUIT 20123456789" -out certificado.csr
```

### 3. Autorizar Web Services

Una vez que tenés el certificado, debés autorizarlo para los web services que vas a usar:

- [Autorizar web service de producción](https://docs.afipsdk.com/recursos/tutoriales-pagina-de-arca/autorizar-web-service-de-produccion)

**Web services necesarios para esta API:**
- `wsfe` - Facturación Electrónica
- `ws_sr_constancia_inscripcion` - Consulta de Contribuyentes (opcional)

### 4. Crear Punto de Venta

Si no tenés un punto de venta habilitado para facturación electrónica:

- [Crear punto de venta](https://docs.afipsdk.com/recursos/tutoriales-pagina-de-arca/crear-punto-de-venta)

---

## Delegación (Opcional)

Si vas a facturar en nombre de otro CUIT:

- [Delegar web service](https://docs.afipsdk.com/recursos/tutoriales-pagina-de-arca/delegar-web-service)
- [Aceptar delegación de web service](https://docs.afipsdk.com/recursos/tutoriales-pagina-de-arca/aceptar-delegacion-de-web-service)

---

## Configurar en esta API

Una vez que tengas los archivos, copialos a la carpeta `src/servicios/certs/`:

```
src/servicios/certs/
├── key.key    # Tu clave privada
└── cert.crt   # Tu certificado
```

Luego configurá el archivo `.env`:

```env
AFIP_CUIT=20123456789   # Tu CUIT (11 dígitos)
AFIP_PTO_VTA=1          # Tu punto de venta
```

---

## Recursos Adicionales

- [Guía completa para obtener certificados](https://afipsdk.com/blog/como-obtener-certificado-para-web-services-arca/)
- [Conectar tu sistema con ARCA](https://afipsdk.com/blog/conectar-tu-sistema-con-los-web-services-de-de-arca/)
- [Comunidad Afip SDK](https://comunidad.afipsdk.com/) - Para resolver dudas

---

## Ambientes ARCA

| Ambiente | URL | Uso |
|----------|-----|-----|
| Testing | `wsaahomo.afip.gov.ar` | Pruebas (facturas sin validez legal) |
| Producción | `wsaa.afip.gov.ar` | Facturas reales |

> **Nota:** Esta API está configurada para **producción** por defecto.
