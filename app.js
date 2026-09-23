// AFIP usa DH débil: Node moderno corta con "dh key too small" si no bajamos el nivel.
require('https').globalAgent.options.ciphers = 'DEFAULT:@SECLEVEL=0';

const express = require('express');
const cors = require('cors');
const moment = require('moment-timezone');
require('dotenv').config();

const {
    createNextVoucher,
    consultarConstancia,
    consultarCondicionIvaReceptor,
    getNextVoucherNumber,
    consultarComprobante,
    armarComprobante,
    armarFacturaConsumidorFinal,
    listarTiposComprobante,
    getTipoComprobante,
    AfipError,
} = require('./src/servicios/afipService');

const {
    middlewareValidarCuit,
    middlewareValidarFactura,
    middlewareValidarClaseComprobante,
    middlewareErrorHandler,
} = require('./src/middleware/validation');

const logInfo = (msg, data) => {
    console.log(`[${moment().format('HH:mm:ss')}] ${msg}`, data ? JSON.stringify(data) : '');
};
const logError = (msg, err) => {
    console.error(`[${moment().format('HH:mm:ss')}] ERROR: ${msg}`, err?.message || err);
};

const app = express();
app.use(express.json());
app.use(cors());

/** Header opcional X-Afip-Secret si está definido AFIP_API_SECRET en el entorno. */
function middlewareAfipSecret(req, res, next) {
    const secret = process.env.AFIP_API_SECRET;
    if (!secret) return next();

    const header = req.get('X-Afip-Secret');
    if (header !== secret) {
        return res.status(401).json({ success: false, error: 'No autorizado' });
    }
    return next();
}

function responderErrorAfip(res, error, fallbackMsg) {
    if (error && (error.afip || error instanceof AfipError)) {
        return res.status(400).json({
            success: false,
            error: error.message || fallbackMsg,
            code: error.code ?? null,
        });
    }

    logError(fallbackMsg, error);
    return res.status(500).json({
        success: false,
        error: error?.message || fallbackMsg,
        code: error?.code ?? null,
    });
}

function leerCuitPtoVta(req) {
    const src = { ...req.query, ...req.body };
    const cuit = (src.cuit || process.env.AFIP_CUIT || '').toString().replace(/[-\s]/g, '');
    const ptoVta = parseInt(src.ptoVta ?? src.ptovta ?? src.PtoVta ?? process.env.AFIP_PTO_VTA, 10);
    return { cuit, ptoVta, src };
}

app.use(middlewareAfipSecret);

app.get('/', (req, res) => {
    res.json({
        name: 'AFIP/ARCA Facturacion API',
        version: '1.2.0',
        endpoints: {
            'GET /afip/tipos': 'Tipos de comprobante (A/B/C, NC, ND)',
            'POST /afip/siguiente': 'Próximo número de comprobante',
            'POST /afip/emitir': 'Emitir factura / NC / ND',
            'POST /afip/comprobante': 'Consultar comprobante (evita doble factura)',
            'POST /afip/ticket': 'Generar comprobante electrónico',
            'POST /afip/ticket-test': 'Factura B de prueba ($100)',
            'GET /afip/contribuyente?cuit=XX': 'Consultar contribuyente',
            'GET /afip/condicion-iva': 'Condiciones IVA',
        },
        tipfac: listarTiposComprobante(),
    });
});

app.use((req, res, next) => {
    if (req.path !== '/') logInfo(`${req.method} ${req.path}`);
    next();
});

/**
 * GET /afip/tipos
 * Lista Factura / NC / ND A-B-C soportados.
 */
app.get('/afip/tipos', (req, res) => {
    res.json({ success: true, data: listarTiposComprobante() });
});

/**
 * POST /afip/siguiente
 * Body: { cuit, ptoVta, tipfac }
 * Devuelve el próximo número a usar (último autorizado + 1).
 */
app.post('/afip/siguiente', async (req, res) => {
    try {
        const { cuit, ptoVta, src } = leerCuitPtoVta(req);
        const tipfac = parseInt(src.tipfac ?? src.CbteTipo ?? 6, 10);

        if (!/^\d{11}$/.test(cuit)) {
            return res.status(400).json({ success: false, error: 'cuit inválido (11 dígitos)' });
        }
        if (!ptoVta || ptoVta < 1) {
            return res.status(400).json({ success: false, error: 'ptoVta inválido' });
        }
        if (!getTipoComprobante(tipfac)) {
            return res.status(400).json({ success: false, error: `tipfac no soportado: ${tipfac}` });
        }

        const siguiente = await getNextVoucherNumber(cuit, ptoVta, tipfac);
        res.json({
            success: true,
            data: {
                cuit,
                ptoVta,
                tipfac,
                tipo: getTipoComprobante(tipfac),
                siguiente,
            },
        });
    } catch (error) {
        return responderErrorAfip(res, error, 'Error consultando siguiente comprobante');
    }
});

/**
 * POST /afip/emitir
 * Emite Factura / Nota de Crédito / Nota de Débito (A, B o C).
 * Body: {
 *   cuit, ptoVta, monto, tipfac?,
 *   doctipo?, docnro?, condicionIva?,
 *   asociado?: { nro, tipfac?, ptoVta?, fecha? },  // obligatorio en NC/ND
 *   cbtesAsoc?: [{ tipo, ptoVta, nro, cuit?, fecha? }]
 * }
 * Default tipfac=6 Factura B CF (doc 99, CondicionIVAReceptorId 5).
 */
app.post('/afip/emitir', async (req, res) => {
    try {
        const { cuit, ptoVta, src } = leerCuitPtoVta(req);
        const monto = parseFloat(src.monto);
        const tipfac = parseInt(src.tipfac ?? 6, 10);

        if (!/^\d{11}$/.test(cuit)) {
            return res.status(400).json({ success: false, error: 'cuit inválido (11 dígitos)' });
        }
        if (!ptoVta || ptoVta < 1) {
            return res.status(400).json({ success: false, error: 'ptoVta inválido' });
        }
        if (isNaN(monto) || monto <= 0) {
            return res.status(400).json({ success: false, error: 'monto debe ser mayor a 0' });
        }
        if (!getTipoComprobante(tipfac)) {
            return res.status(400).json({ success: false, error: `tipfac no soportado: ${tipfac}` });
        }

        const armado = armarComprobante({
            cuit,
            ptoVta,
            monto,
            tipfac,
            doctipo: src.doctipo ?? (getTipoComprobante(tipfac).clase === 'A' ? 80 : 99),
            docnro: src.docnro ?? 0,
            condicionIva: src.condicionIva ?? src.CondicionIVAReceptorId,
            asociado: src.asociado,
            cbtesAsoc: src.cbtesAsoc || src.CbtesAsoc,
        });

        const resp = await createNextVoucher(armado.cuit, armado.datosFactura);

        logInfo('Comprobante emitido', {
            CAE: resp.CAE,
            numero: resp.voucherNumber,
            tipfac,
            monto,
        });

        res.json({
            success: true,
            data: {
                ...resp,
                ...armado.montos,
                cuit: armado.cuit,
                ptoVta,
                tipfac,
                tipo: armado.tipo,
                CondicionIVAReceptorId: armado.datosFactura.FeDetReq[0].CondicionIVAReceptorId,
                CbtesAsoc: armado.datosFactura.FeDetReq[0].CbtesAsoc || null,
            },
        });
    } catch (error) {
        return responderErrorAfip(res, error, 'Error emitiendo comprobante');
    }
});

/**
 * POST /afip/comprobante
 * Consulta un comprobante ya emitido (FECompConsultar).
 * Sirve para no facturar dos veces si la respuesta se cortó.
 * Body: { cuit, ptoVta, tipfac, nro }
 */
app.post('/afip/comprobante', async (req, res) => {
    try {
        const { cuit, ptoVta, src } = leerCuitPtoVta(req);
        const tipfac = parseInt(src.tipfac ?? src.CbteTipo ?? 6, 10);
        const nro = parseInt(src.nro ?? src.cbteNro ?? src.CbteNro, 10);

        if (!/^\d{11}$/.test(cuit)) {
            return res.status(400).json({ success: false, error: 'cuit inválido (11 dígitos)' });
        }
        if (!ptoVta || ptoVta < 1) {
            return res.status(400).json({ success: false, error: 'ptoVta inválido' });
        }
        if (!nro || nro < 1) {
            return res.status(400).json({ success: false, error: 'nro de comprobante inválido' });
        }
        if (!getTipoComprobante(tipfac)) {
            return res.status(400).json({ success: false, error: `tipfac no soportado: ${tipfac}` });
        }

        const result = await consultarComprobante(cuit, ptoVta, tipfac, nro);

        if (!result.encontrado) {
            return res.json({
                success: true,
                encontrado: false,
                data: null,
                code: result.code ?? null,
                message: result.message || 'Comprobante no encontrado',
            });
        }

        res.json({
            success: true,
            encontrado: true,
            data: {
                ...result.data,
                tipo: getTipoComprobante(tipfac),
            },
        });
    } catch (error) {
        return responderErrorAfip(res, error, 'Error consultando comprobante');
    }
});

// --- Endpoints previos (compat) ---

app.get('/afip/contribuyente', middlewareValidarCuit, async (req, res) => {
    try {
        const cuitEmisor = (req.query.cuitEmisor || process.env.AFIP_CUIT || req.cuit)
            .toString()
            .replace(/[-\s]/g, '');
        const result = await consultarConstancia(req.cuit, cuitEmisor);

        if (result?.personaReturn?.datosGenerales) {
            const datos = result.personaReturn.datosGenerales;
            const domicilio = datos.domicilioFiscal;

            const razonSocial =
                datos.tipoPersona === 'FISICA'
                    ? `${datos.apellido} ${datos.nombre}`
                    : datos.razonSocial;

            const condicionIVA =
                result.personaReturn.datosRegimenGeneral?.impuesto?.length > 0
                    ? 'Resp. Inscripto'
                    : 'Exento';

            return res.json({
                success: true,
                data: {
                    razonSocial,
                    cuit: datos.idPersona,
                    tipoPersona: datos.tipoPersona,
                    condicionIVA,
                    tipoFactura: condicionIVA === 'Resp. Inscripto' ? 1 : 6,
                    domicilio: domicilio.direccion,
                    localidad: domicilio.localidad || domicilio.datoAdicional,
                    provincia: domicilio.descripcionProvincia,
                    codigoPostal: domicilio.codPostal,
                },
            });
        }

        res.status(404).json({ success: false, error: 'Contribuyente no encontrado' });
    } catch (error) {
        return responderErrorAfip(res, error, 'Error consultando AFIP');
    }
});

app.post('/afip/ticket-test', async (req, res) => {
    try {
        const { cuit, ptoVta } = leerCuitPtoVta(req);
        if (!/^\d{11}$/.test(cuit) || !ptoVta) {
            return res.status(400).json({
                success: false,
                error: 'Se requiere cuit y ptoVta (body/query o .env)',
            });
        }

        const armado = armarFacturaConsumidorFinal({
            cuit,
            ptoVta,
            monto: 100,
            tipfac: 6,
            doctipo: 99,
            docnro: 0,
            condicionIva: 5,
        });

        const resp = await createNextVoucher(armado.cuit, armado.datosFactura);
        logInfo('Factura prueba', { CAE: resp.CAE, numero: resp.voucherNumber });

        res.json({
            success: true,
            data: { ...resp, ...armado.montos },
        });
    } catch (error) {
        return responderErrorAfip(res, error, 'Error generando factura');
    }
});

app.post('/afip/ticket', middlewareValidarFactura, async (req, res) => {
    try {
        const {
            docTipoNum,
            docNroNum,
            tipFacNum,
            montoNum,
            asociado,
            cbtesAsoc,
            condicionIva,
        } = req.datosValidados;
        const { cuit, ptoVta } = leerCuitPtoVta(req);

        if (!/^\d{11}$/.test(cuit) || !ptoVta) {
            return res.status(400).json({
                success: false,
                error: 'Se requiere cuit y ptoVta (body/query o .env)',
            });
        }

        const armado = armarComprobante({
            cuit,
            ptoVta,
            monto: montoNum,
            tipfac: tipFacNum,
            doctipo: docTipoNum,
            docnro: docNroNum,
            condicionIva,
            asociado,
            cbtesAsoc,
        });

        const resp = await createNextVoucher(armado.cuit, armado.datosFactura);
        logInfo('Comprobante generado', {
            CAE: resp.CAE,
            numero: resp.voucherNumber,
            tipfac: tipFacNum,
            monto: montoNum,
        });

        res.json({
            success: true,
            data: {
                ...resp,
                ...armado.montos,
                tipfac: tipFacNum,
                tipo: armado.tipo,
            },
        });
    } catch (error) {
        return responderErrorAfip(res, error, 'Error generando comprobante');
    }
});

app.get('/afip/condicion-iva', middlewareValidarClaseComprobante, async (req, res) => {
    try {
        const { cuit } = leerCuitPtoVta(req);
        if (!/^\d{11}$/.test(cuit)) {
            return res.status(400).json({ success: false, error: 'cuit inválido' });
        }
        const data = await consultarCondicionIvaReceptor(cuit, req.claseComprobante);
        res.json({ success: true, data });
    } catch (error) {
        return responderErrorAfip(res, error, 'Error consultando condiciones IVA');
    }
});

app.use(middlewareErrorHandler);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    logInfo(`API corriendo en puerto ${PORT}`);
    console.log(`  CUIT default: ***${process.env.AFIP_CUIT?.slice(-4) || 'NO CONFIGURADO'}`);
    console.log(`  PTO VTA default: ${process.env.AFIP_PTO_VTA || 'NO CONFIGURADO'}`);
    console.log(`  Secret: ${process.env.AFIP_API_SECRET ? 'activo (X-Afip-Secret)' : 'desactivado'}`);
});
