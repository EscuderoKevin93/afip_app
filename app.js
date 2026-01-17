const express = require('express');
const cors = require("cors");
const moment = require("moment-timezone");
require('dotenv').config();
const { createNextVoucher, consultarConstancia, consultarCondicionIvaReceptor } = require('./src/servicios/afipService');
const { 
    middlewareValidarCuit, 
    middlewareValidarFactura, 
    middlewareValidarClaseComprobante,
    middlewareErrorHandler 
} = require('./src/middleware/validation');

// Logging
const logInfo = (msg, data) => {
    console.log(`[${moment().format('HH:mm:ss')}] ${msg}`, data ? JSON.stringify(data) : '');
};
const logError = (msg, err) => {
    console.error(`[${moment().format('HH:mm:ss')}] ERROR: ${msg}`, err?.message || err);
};

const app = express();
app.use(express.json());
app.use(cors());

app.get('/', (req, res) => {
    res.json({
        name: 'AFIP/ARCA Facturacion API',
        version: '1.0.0',
        endpoints: {
            'POST /afip/ticket': 'Generar factura electronica',
            'POST /afip/ticket-test': 'Factura de prueba ($100)',
            'GET /afip/contribuyente?cuit=XX': 'Consultar contribuyente',
            'GET /afip/condicion-iva': 'Condiciones IVA'
        }
    });
});

// Logging de requests
app.use((req, res, next) => {
    if (req.path !== '/') logInfo(`${req.method} ${req.path}`);
    next();
});

// Consultar contribuyente
app.get('/afip/contribuyente', middlewareValidarCuit, async (req, res) => {
    try {
        const result = await consultarConstancia(req.cuit);
        
        if (result?.personaReturn?.datosGenerales) {
            const datos = result.personaReturn.datosGenerales;
            const domicilio = datos.domicilioFiscal;

            const razonSocial = datos.tipoPersona === "FISICA"
                ? `${datos.apellido} ${datos.nombre}`
                : datos.razonSocial;

            const condicionIVA = result.personaReturn.datosRegimenGeneral?.impuesto?.length > 0
                ? "Resp. Inscripto"
                : "Exento";

            return res.json({
                success: true,
                data: {
                    razonSocial,
                    cuit: datos.idPersona,
                    tipoPersona: datos.tipoPersona,
                    condicionIVA,
                    tipoFactura: condicionIVA === "Resp. Inscripto" ? 1 : 6,
                    domicilio: domicilio.direccion,
                    localidad: domicilio.localidad || domicilio.datoAdicional,
                    provincia: domicilio.descripcionProvincia,
                    codigoPostal: domicilio.codPostal
                }
            });
        }
        
        res.status(404).json({ success: false, error: "Contribuyente no encontrado" });
    } catch (error) {
        logError("Consulta contribuyente", error);
        res.status(500).json({ success: false, error: "Error consultando AFIP" });
    }
});

// Factura de prueba ($100)
app.post("/afip/ticket-test", async (req, res) => {
    try {
        logInfo("Generando factura de prueba");
        
        const monto = 100;
        const neto = parseFloat((monto / 1.21).toFixed(2));
        const iva = parseFloat((monto - neto).toFixed(2));
        const fecha = new Date().toISOString().split("T")[0].replace(/-/g, "");

        const datosFactura = {
            FeCabReq: { CbteTipo: 6, CantReg: 1, PtoVta: parseInt(process.env.AFIP_PTO_VTA) },
            FeDetReq: [{
                Concepto: 1,
                DocTipo: 99, // Consumidor Final
                DocNro: 0,
                CbteFch: fecha,
                ImpTotal: monto,
                ImpTotConc: 0,
                ImpNeto: neto,
                ImpOpEx: 0,
                ImpTrib: 0,
                ImpIVA: iva,
                MonId: "PES",
                MonCotiz: 1,
                Iva: [{ Id: 5, BaseImp: neto, Importe: iva }]
            }]
        };

        const resp = await createNextVoucher(datosFactura);
        
        logInfo("Factura generada", { CAE: resp.CAE, numero: resp.voucherNumber });
        
        res.json({
            success: true,
            data: { ...resp, montoTotal: monto, montoNeto: neto, montoIVA: iva }
        });
    } catch (error) {
        logError("Factura prueba", error);
        res.status(500).json({ success: false, error: "Error generando factura" });
    }
});

// Generar factura
app.post("/afip/ticket", middlewareValidarFactura, async (req, res) => {
    try {
        const { docTipoNum, docNroNum, tipFacNum, montoNum } = req.datosValidados;

        const neto = parseFloat((montoNum / 1.21).toFixed(2));
        const iva = parseFloat((montoNum - neto).toFixed(2));
        const fecha = new Date().toISOString().split("T")[0].replace(/-/g, "");

        const datosFactura = {
            FeCabReq: { CbteTipo: tipFacNum, CantReg: 1, PtoVta: parseInt(process.env.AFIP_PTO_VTA) },
            FeDetReq: [{
                Concepto: 1,
                DocTipo: docTipoNum,
                DocNro: docNroNum,
                CbteFch: fecha,
                ImpTotal: montoNum,
                ImpTotConc: 0,
                ImpNeto: neto,
                ImpOpEx: 0,
                ImpTrib: 0,
                ImpIVA: iva,
                MonId: "PES",
                MonCotiz: 1,
                Iva: [{ Id: 5, BaseImp: neto, Importe: iva }]
            }]
        };

        const resp = await createNextVoucher(datosFactura);
        
        logInfo("Factura generada", { CAE: resp.CAE, numero: resp.voucherNumber, monto: montoNum });
        
        res.json({
            success: true,
            data: { ...resp, montoTotal: montoNum, montoNeto: neto, montoIVA: iva }
        });
    } catch (error) {
        logError("Generar factura", error);
        res.status(500).json({ success: false, error: "Error generando factura" });
    }
});

// Condiciones IVA
app.get('/afip/condicion-iva', middlewareValidarClaseComprobante, async (req, res) => {
    try {
        const data = await consultarCondicionIvaReceptor(req.claseComprobante);
        res.json({ success: true, data });
    } catch (error) {
        logError("Condicion IVA", error);
        res.status(500).json({ success: false, error: "Error consultando condiciones IVA" });
    }
});

app.use(middlewareErrorHandler);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    logInfo(`API corriendo en puerto ${PORT}`);
    console.log(`  CUIT: ***${process.env.AFIP_CUIT?.slice(-4) || 'NO CONFIGURADO'}`);
    console.log(`  PTO VTA: ${process.env.AFIP_PTO_VTA || 'NO CONFIGURADO'}`);
});
