// Middleware de validación para AFIP API

const {
    TIPOS_COMPROBANTE_IDS,
    getTipoComprobante,
    esNotaCreditoODebito,
} = require('../servicios/afipService');

const validarCuit = (cuit) => {
    if (!cuit) return { valido: false, error: "El parámetro 'cuit' es obligatorio" };

    const cuitLimpio = cuit.toString().replace(/[-\s]/g, '');
    if (!/^\d{11}$/.test(cuitLimpio)) {
        return { valido: false, error: 'El CUIT debe tener 11 dígitos' };
    }

    return { valido: true, cuit: cuitLimpio };
};

const validarAsociado = (datos, tipFacNum) => {
    if (!esNotaCreditoODebito(tipFacNum)) {
        return { valido: true, asociado: null, cbtesAsoc: null };
    }

    const cbtesAsoc = datos.cbtesAsoc || datos.CbtesAsoc || null;
    const asociado = datos.asociado || null;

    if (cbtesAsoc) {
        const lista = Array.isArray(cbtesAsoc) ? cbtesAsoc : [cbtesAsoc];
        const ok = lista.some((c) => {
            const nro = parseInt(c.Nro ?? c.nro ?? c.CbteNro ?? c.cbteNro, 10);
            const pto = parseInt(c.PtoVta ?? c.ptoVta ?? c.ptovta, 10);
            const tipo = parseInt(c.Tipo ?? c.tipo ?? c.CbteTipo ?? c.tipfac, 10);
            return nro > 0 && pto > 0 && tipo > 0;
        });
        if (!ok) {
            return {
                valido: false,
                error: 'cbtesAsoc inválido: cada ítem necesita tipo, ptoVta y nro',
            };
        }
        return { valido: true, asociado: null, cbtesAsoc };
    }

    if (asociado) {
        const nro = parseInt(asociado.nro ?? asociado.cbteNro ?? asociado.Nro, 10);
        if (!nro || nro < 1) {
            return { valido: false, error: 'asociado.nro es obligatorio para NC/ND' };
        }
        return { valido: true, asociado, cbtesAsoc: null };
    }

    return {
        valido: false,
        error: 'Notas de crédito/débito requieren asociado { nro, tipfac?, ptoVta? } o cbtesAsoc',
    };
};

const validarDatosFactura = (datos) => {
    const { doctipo, docnro, monto, tipfac } = datos;

    if (doctipo === undefined || docnro === undefined || !monto || tipfac === undefined) {
        return {
            valido: false,
            error: 'Campos requeridos: doctipo, docnro, monto, tipfac',
        };
    }

    const docTipoNum = parseInt(doctipo, 10);
    if (isNaN(docTipoNum) || docTipoNum < 0) {
        return { valido: false, error: 'Tipo de documento inválido' };
    }

    const docNroNum = docTipoNum === 99 ? 0 : parseInt(docnro, 10);
    if (docTipoNum !== 99 && (isNaN(docNroNum) || docNroNum <= 0)) {
        return { valido: false, error: 'Número de documento inválido' };
    }

    const tipFacNum = parseInt(tipfac, 10);
    if (!TIPOS_COMPROBANTE_IDS.includes(tipFacNum)) {
        return {
            valido: false,
            error: `tipfac inválido. Permitidos: ${TIPOS_COMPROBANTE_IDS.join(', ')}`,
        };
    }

    const montoNum = parseFloat(monto);
    if (isNaN(montoNum) || montoNum <= 0) {
        return { valido: false, error: 'Monto debe ser mayor a 0' };
    }

    const asoc = validarAsociado(datos, tipFacNum);
    if (!asoc.valido) {
        return { valido: false, error: asoc.error };
    }

    return {
        valido: true,
        datos: {
            docTipoNum,
            docNroNum,
            tipFacNum,
            montoNum,
            tipo: getTipoComprobante(tipFacNum),
            asociado: asoc.asociado,
            cbtesAsoc: asoc.cbtesAsoc,
            condicionIva: datos.condicionIva ?? datos.CondicionIVAReceptorId,
        },
    };
};

const middlewareValidarCuit = (req, res, next) => {
    const cuit = req.query.cuit || req.body.cuit;
    const validacion = validarCuit(cuit);

    if (!validacion.valido) {
        return res.status(400).json({ success: false, error: validacion.error });
    }

    req.cuit = validacion.cuit;
    next();
};

const middlewareValidarFactura = (req, res, next) => {
    const validacion = validarDatosFactura(req.body);

    if (!validacion.valido) {
        return res.status(400).json({ success: false, error: validacion.error });
    }

    req.datosValidados = validacion.datos;
    next();
};

const middlewareValidarClaseComprobante = (req, res, next) => {
    const { clase } = req.query;
    const claseComprobante = clase ? clase.toUpperCase() : null;

    if (claseComprobante && !['A', 'B', 'C'].includes(claseComprobante)) {
        return res.status(400).json({
            success: false,
            error: 'Clase debe ser A, B o C',
        });
    }

    req.claseComprobante = claseComprobante;
    next();
};

const middlewareErrorHandler = (err, req, res, next) => {
    console.error('[ERROR]', err);
    res.status(500).json({
        success: false,
        error: 'Error interno del servidor',
    });
};

module.exports = {
    validarCuit,
    validarDatosFactura,
    validarAsociado,
    middlewareValidarCuit,
    middlewareValidarFactura,
    middlewareValidarClaseComprobante,
    middlewareErrorHandler,
};
