// Middleware de validación para AFIP API

// Validador de CUIT
const validarCuit = (cuit) => {
    if (!cuit) return { valido: false, error: "El parámetro 'cuit' es obligatorio" };
    
    const cuitLimpio = cuit.toString().replace(/[-\s]/g, '');
    if (!/^\d{11}$/.test(cuitLimpio)) {
        return { valido: false, error: "El CUIT debe tener 11 dígitos" };
    }
    
    return { valido: true, cuit: cuitLimpio };
};

// Validador de datos de facturación
const validarDatosFactura = (datos) => {
    const { doctipo, docnro, monto, tipfac } = datos;
    
    if (doctipo === undefined || docnro === undefined || !monto || !tipfac) {
        return {
            valido: false,
            error: "Campos requeridos: doctipo, docnro, monto, tipfac"
        };
    }

    const docTipoNum = parseInt(doctipo);
    if (isNaN(docTipoNum) || docTipoNum < 0) {
        return { valido: false, error: "Tipo de documento inválido" };
    }

    // Consumidor Final (99) permite docnro = 0
    const docNroNum = docTipoNum === 99 ? 0 : parseInt(docnro);
    if (docTipoNum !== 99 && (isNaN(docNroNum) || docNroNum <= 0)) {
        return { valido: false, error: "Número de documento inválido" };
    }

    const tipFacNum = parseInt(tipfac);
    if (![1, 6].includes(tipFacNum)) {
        return { valido: false, error: "Tipo de factura debe ser 1 (A) o 6 (B)" };
    }

    const montoNum = parseFloat(monto);
    if (isNaN(montoNum) || montoNum <= 0) {
        return { valido: false, error: "Monto debe ser mayor a 0" };
    }

    return {
        valido: true,
        datos: { docTipoNum, docNroNum, tipFacNum, montoNum }
    };
};

// Middleware: validar CUIT
const middlewareValidarCuit = (req, res, next) => {
    const cuit = req.query.cuit || req.body.cuit;
    const validacion = validarCuit(cuit);
    
    if (!validacion.valido) {
        return res.status(400).json({ success: false, error: validacion.error });
    }
    
    req.cuit = validacion.cuit;
    next();
};

// Middleware: validar datos de factura
const middlewareValidarFactura = (req, res, next) => {
    const validacion = validarDatosFactura(req.body);
    
    if (!validacion.valido) {
        return res.status(400).json({ success: false, error: validacion.error });
    }
    
    req.datosValidados = validacion.datos;
    next();
};

// Middleware: validar clase de comprobante
const middlewareValidarClaseComprobante = (req, res, next) => {
    const { clase } = req.query;
    const claseComprobante = clase ? clase.toUpperCase() : null;

    if (claseComprobante && !['A', 'B'].includes(claseComprobante)) {
        return res.status(400).json({ 
            success: false, 
            error: 'Clase debe ser A o B' 
        });
    }

    req.claseComprobante = claseComprobante;
    next();
};

// Middleware: manejo de errores
const middlewareErrorHandler = (err, req, res, next) => {
    console.error('[ERROR]', err);
    res.status(500).json({
        success: false,
        error: "Error interno del servidor"
    });
};

module.exports = {
    validarCuit,
    validarDatosFactura,
    middlewareValidarCuit,
    middlewareValidarFactura,
    middlewareValidarClaseComprobante,
    middlewareErrorHandler
};
