const fs = require('fs');
const path = require('path');
const soap = require('soap');
const forge = require('node-forge');
const xml2js = require('xml2js');

const PRIVATE_KEY_PATH = path.join(__dirname, '/certs/key.key');
const CERT_PATH = path.join(__dirname, '/certs/cert.crt');
const WSAA_WSDL = path.join(__dirname, './wsaa.wsdl');
const WSAA_URL = 'https://wsaa.afip.gov.ar/ws/services/LoginCms';
const WSDL_WSFE = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL';
const WSDL_CONSTANCIA = 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5?WSDL';

const tokenCache = new Map();
const TOKEN_CACHE_DURATION = 11 * 60 * 1000;

const cleanExpiredTokens = () => {
    const now = Date.now();
    for (const [key, value] of tokenCache.entries()) {
        if (now - value.timestamp > TOKEN_CACHE_DURATION) {
            tokenCache.delete(key);
        }
    }
};

setInterval(cleanExpiredTokens, 60000);

function limpiarCacheTokens() {
    tokenCache.clear();
}

/** Extrae código/mensaje útil de respuestas o fallos de ARCA/AFIP. */
function extraerErrorAfip(errorOrResult) {
    if (!errorOrResult) return null;

    const errors =
        errorOrResult.Errors?.Err ||
        errorOrResult.FECAESolicitarResult?.Errors?.Err ||
        errorOrResult.FECompConsultarResult?.Errors?.Err ||
        errorOrResult.FECompUltimoAutorizadoResult?.Errors?.Err ||
        errorOrResult.FEParamGetCondicionIvaReceptorResult?.Errors?.Err;

    if (errors) {
        const list = Array.isArray(errors) ? errors : [errors];
        if (list.length > 0) {
            const e = list[0];
            return {
                code: e.Code ?? e.code ?? null,
                message: e.Msg ?? e.msg ?? String(e),
            };
        }
    }

    const obs =
        errorOrResult.FECAESolicitarResult?.FeDetResp?.FECAEDetResponse?.[0]?.Observaciones?.Obs ||
        errorOrResult.Observaciones?.Obs;

    if (obs) {
        const list = Array.isArray(obs) ? obs : [obs];
        if (list.length > 0) {
            const o = list[0];
            return {
                code: o.Code ?? o.code ?? null,
                message: o.Msg ?? o.msg ?? String(o),
            };
        }
    }

    if (errorOrResult.root?.Envelope?.Body?.Fault) {
        const fault = errorOrResult.root.Envelope.Body.Fault;
        return {
            code: fault.faultcode || null,
            message: fault.faultstring || 'Fault de AFIP',
        };
    }

    if (errorOrResult.message) {
        return { code: null, message: errorOrResult.message };
    }

    return null;
}

class AfipError extends Error {
    constructor(code, message) {
        super(message || 'Error de ARCA/AFIP');
        this.name = 'AfipError';
        this.code = code ?? null;
        this.afip = true;
    }
}

function throwIfAfipError(result, wrapperKey) {
    const payload = wrapperKey ? result?.[wrapperKey] : result;
    const err = extraerErrorAfip(payload) || extraerErrorAfip(result);
    if (err && (payload?.Errors || result?.Errors)) {
        throw new AfipError(err.code, err.message);
    }
}

async function manejarErrorAutenticacion(error, service) {
    if (error.message && error.message.includes('alreadyAuthenticated')) {
        limpiarCacheTokens();
        return await obtenerTokenSign(service);
    }
    const afipErr = extraerErrorAfip(error);
    if (afipErr) {
        throw new AfipError(afipErr.code, afipErr.message);
    }
    throw error;
}

function crearCMS(service) {
    try {
        const tra = `<?xml version="1.0" encoding="UTF-8"?>
        <loginTicketRequest version="1.0">
          <header>
            <uniqueId>${Math.floor(Date.now() / 1000)}</uniqueId>
            <generationTime>${new Date(Date.now() - 600000).toISOString()}</generationTime>
            <expirationTime>${new Date(Date.now() + 600000).toISOString()}</expirationTime>
          </header>
          <service>${service}</service>
        </loginTicketRequest>`;

        const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
        const certificate = fs.readFileSync(CERT_PATH, 'utf8');

        const p7 = forge.pkcs7.createSignedData();
        p7.content = forge.util.createBuffer(tra, 'utf8');
        p7.addCertificate(certificate);
        p7.addSigner({
            key: privateKey,
            certificate: certificate,
            digestAlgorithm: forge.pki.oids.sha256,
        });
        p7.sign();

        return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary').toString('base64');
    } catch (error) {
        throw new Error('Error al generar el ticket de autenticación (revisar certificado/key)');
    }
}

async function obtenerTokenSign(service) {
    const cachedToken = tokenCache.get(service);
    if (cachedToken && Date.now() - cachedToken.timestamp < TOKEN_CACHE_DURATION) {
        return cachedToken.credentials;
    }

    try {
        const cms = crearCMS(service);
        const client = await soap.createClientAsync(WSAA_WSDL, { endpoint: WSAA_URL });

        try {
            const [result] = await client.loginCmsAsync({ in0: cms });
            const parser = new xml2js.Parser({ explicitArray: false });
            const parsed = await parser.parseStringPromise(result.loginCmsReturn);

            const credentials = parsed.loginTicketResponse?.credentials;
            if (!credentials || !credentials.token || !credentials.sign) {
                throw new AfipError(null, 'No se encontraron las credenciales en la respuesta del WSAA');
            }

            tokenCache.set(service, {
                credentials,
                timestamp: Date.now(),
            });

            return credentials;
        } catch (error) {
            if (error.message && error.message.includes('alreadyAuthenticated')) {
                try {
                    const errorResponse = error.root?.Envelope?.Body?.Fault?.detail;
                    if (errorResponse?.token && errorResponse?.sign) {
                        const credentials = {
                            token: errorResponse.token,
                            sign: errorResponse.sign,
                        };
                        tokenCache.set(service, {
                            credentials,
                            timestamp: Date.now(),
                        });
                        return credentials;
                    }
                } catch (_) {
                    /* continuar */
                }
            }

            const afipErr = extraerErrorAfip(error);
            if (afipErr) {
                throw new AfipError(afipErr.code, afipErr.message);
            }
            throw error;
        }
    } catch (error) {
        if (error.afip) throw error;
        const afipErr = extraerErrorAfip(error);
        if (afipErr) {
            throw new AfipError(afipErr.code, afipErr.message);
        }
        throw new AfipError(
            null,
            error.message || 'Error de autenticación con AFIP/ARCA (computador fiscal autorizado?)'
        );
    }
}

async function getLastVoucher(cuit, salesPoint, type) {
    try {
        const { token, sign } = await obtenerTokenSign('wsfe');
        const client = await soap.createClientAsync(WSDL_WSFE);

        const args = {
            Auth: {
                Token: token,
                Sign: sign,
                Cuit: cuit,
            },
            PtoVta: salesPoint,
            CbteTipo: type,
        };

        const [response] = await client.FECompUltimoAutorizadoAsync(args);
        throwIfAfipError(response, 'FECompUltimoAutorizadoResult');

        if (!response || !response.FECompUltimoAutorizadoResult) {
            throw new AfipError(null, 'No se pudo obtener el último comprobante autorizado');
        }

        return response.FECompUltimoAutorizadoResult.CbteNro;
    } catch (error) {
        if (error.message && error.message.includes('alreadyAuthenticated')) {
            return await manejarErrorAutenticacion(error, 'wsfe');
        }
        if (error.afip) throw error;
        const afipErr = extraerErrorAfip(error);
        if (afipErr) throw new AfipError(afipErr.code, afipErr.message);
        throw error;
    }
}

async function getNextVoucherNumber(cuit, salesPoint, type) {
    const last = await getLastVoucher(cuit, salesPoint, type);
    return Number(last) + 1;
}

async function consultarComprobante(cuit, ptoVta, cbteTipo, cbteNro) {
    try {
        const { token, sign } = await obtenerTokenSign('wsfe');
        const client = await soap.createClientAsync(WSDL_WSFE);

        const args = {
            Auth: {
                Token: token,
                Sign: sign,
                Cuit: cuit,
            },
            FeCompConsReq: {
                CbteTipo: cbteTipo,
                CbteNro: cbteNro,
                PtoVta: ptoVta,
            },
        };

        const [response] = await client.FECompConsultarAsync(args);
        const result = response?.FECompConsultarResult;

        if (result?.Errors?.Err) {
            const err = extraerErrorAfip(result);
            // 602 = no existe ese comprobante
            if (err && (err.code === 602 || err.code === '602')) {
                return { encontrado: false, code: err.code, message: err.message };
            }
            throw new AfipError(err?.code, err?.message || 'Error al consultar comprobante');
        }

        const det = result?.ResultGet;
        if (!det) {
            return { encontrado: false };
        }

        return {
            encontrado: true,
            data: {
                CAE: det.CodAutorizacion || det.CAE,
                CAEFchVto: det.FchVto || det.CAEFchVto,
                voucherNumber: det.CbteDesde || cbteNro,
                CbteTipo: det.CbteTipo,
                PtoVta: det.PtoVta,
                DocTipo: det.DocTipo,
                DocNro: det.DocNro,
                ImpTotal: det.ImpTotal,
                ImpNeto: det.ImpNeto,
                ImpIVA: det.ImpIVA,
                CbteFch: det.CbteFch,
                Resultado: det.Resultado,
            },
        };
    } catch (error) {
        if (error.message && error.message.includes('alreadyAuthenticated')) {
            return await manejarErrorAutenticacion(error, 'wsfe');
        }
        if (error.afip) throw error;
        const afipErr = extraerErrorAfip(error);
        if (afipErr) throw new AfipError(afipErr.code, afipErr.message);
        throw error;
    }
}

async function createNextVoucher(cuit, data) {
    try {
        const lastVoucher = await getLastVoucher(cuit, data.FeCabReq.PtoVta, data.FeCabReq.CbteTipo);
        const voucherNumber = Number(lastVoucher) + 1;

        data.FeDetReq[0].CbteDesde = voucherNumber;
        data.FeDetReq[0].CbteHasta = voucherNumber;

        const factura = await generarFactura(cuit, data);
        const result = factura.FECAESolicitarResult;

        if (result?.Errors?.Err) {
            const err = extraerErrorAfip(result);
            throw new AfipError(err?.code, err?.message || 'ARCA rechazó la solicitud');
        }

        const detalleRespuesta = result?.FeDetResp?.FECAEDetResponse;
        const detalle = Array.isArray(detalleRespuesta) ? detalleRespuesta[0] : detalleRespuesta;

        if (!detalle) {
            throw new AfipError(null, 'No se encontró la respuesta de detalle en FeDetResp');
        }

        if (detalle.Resultado === 'R') {
            const err = extraerErrorAfip({ FECAESolicitarResult: result }) ||
                extraerErrorAfip(detalle);
            throw new AfipError(
                err?.code,
                err?.message || 'ARCA rechazó el comprobante'
            );
        }

        return {
            CAE: detalle.CAE,
            CAEFchVto: detalle.CAEFchVto,
            voucherNumber,
            Resultado: detalle.Resultado,
        };
    } catch (error) {
        if (error.message && error.message.includes('alreadyAuthenticated')) {
            return await manejarErrorAutenticacion(error, 'wsfe');
        }
        if (error.afip) throw error;
        const afipErr = extraerErrorAfip(error);
        if (afipErr) throw new AfipError(afipErr.code, afipErr.message);
        throw error;
    }
}

async function consultarCondicionIvaReceptor(cuit, claseComprobante = null) {
    try {
        const { token, sign } = await obtenerTokenSign('wsfe');
        const client = await soap.createClientAsync(WSDL_WSFE);

        const req = {
            Auth: {
                Token: token,
                Sign: sign,
                Cuit: cuit,
            },
        };

        if (claseComprobante) {
            req.ClaseCmp = claseComprobante;
        }

        const [response] = await client.FEParamGetCondicionIvaReceptorAsync(req);

        if (!response || !response.FEParamGetCondicionIvaReceptorResult) {
            throw new AfipError(null, 'Error al obtener la condición IVA del receptor. Respuesta no válida.');
        }

        const result = response.FEParamGetCondicionIvaReceptorResult;

        if (result.Errors && result.Errors.Err) {
            const err = extraerErrorAfip(result);
            throw new AfipError(err?.code, err?.message);
        }

        const raw = result.ResultGet?.CondicionIvaReceptor;
        if (!raw) {
            throw new AfipError(null, 'No se encontraron condiciones IVA para el receptor');
        }

        const list = Array.isArray(raw) ? raw : [raw];

        return list.map((condicion) => ({
            Id: condicion.Id,
            Desc: condicion.Desc,
            Cmp_Clase: condicion.Cmp_Clase,
            FechaDesde: condicion.FechaDesde,
            FechaHasta: condicion.FechaHasta,
        }));
    } catch (error) {
        if (error.message && error.message.includes('alreadyAuthenticated')) {
            return await manejarErrorAutenticacion(error, 'wsfe');
        }
        if (error.afip) throw error;
        const afipErr = extraerErrorAfip(error);
        if (afipErr) throw new AfipError(afipErr.code, afipErr.message);
        throw error;
    }
}

/** Tipos de comprobante WSFE habituales (A/B/C + NC/ND). */
const TIPOS_COMPROBANTE = {
    1: { id: 1, letra: 'A', clase: 'A', kind: 'factura', desc: 'Factura A' },
    2: { id: 2, letra: 'A', clase: 'A', kind: 'debito', desc: 'Nota de Débito A' },
    3: { id: 3, letra: 'A', clase: 'A', kind: 'credito', desc: 'Nota de Crédito A' },
    6: { id: 6, letra: 'B', clase: 'B', kind: 'factura', desc: 'Factura B' },
    7: { id: 7, letra: 'B', clase: 'B', kind: 'debito', desc: 'Nota de Débito B' },
    8: { id: 8, letra: 'B', clase: 'B', kind: 'credito', desc: 'Nota de Crédito B' },
    11: { id: 11, letra: 'C', clase: 'C', kind: 'factura', desc: 'Factura C' },
    12: { id: 12, letra: 'C', clase: 'C', kind: 'debito', desc: 'Nota de Débito C' },
    13: { id: 13, letra: 'C', clase: 'C', kind: 'credito', desc: 'Nota de Crédito C' },
};

const TIPOS_COMPROBANTE_IDS = Object.keys(TIPOS_COMPROBANTE).map(Number);

function getTipoComprobante(tipfac) {
    return TIPOS_COMPROBANTE[Number(tipfac)] || null;
}

function esNotaCreditoODebito(tipfac) {
    const t = getTipoComprobante(tipfac);
    return Boolean(t && (t.kind === 'credito' || t.kind === 'debito'));
}

/** Factura “madre” sugerida para asociar NC/ND de la misma letra. */
function facturaAsociadaSugerida(tipfac) {
    const t = getTipoComprobante(tipfac);
    if (!t) return null;
    if (t.letra === 'A') return 1;
    if (t.letra === 'B') return 6;
    if (t.letra === 'C') return 11;
    return null;
}

function listarTiposComprobante() {
    return TIPOS_COMPROBANTE_IDS.map((id) => ({ ...TIPOS_COMPROBANTE[id] }));
}

/**
 * Condición IVA receptor por defecto según tipo de comprobante / documento.
 * A => 1 (RI); B/C + Consumidor Final (99) => 5; resto B/C => 5
 */
function resolverCondicionIvaReceptorId(cbteTipo, docTipo, condicionIvaExplicit) {
    if (condicionIvaExplicit !== undefined && condicionIvaExplicit !== null && condicionIvaExplicit !== '') {
        return parseInt(condicionIvaExplicit, 10);
    }
    const tipo = getTipoComprobante(cbteTipo);
    if (tipo?.clase === 'A') {
        return 1;
    }
    if (Number(docTipo) === 99) {
        return 5;
    }
    return 5;
}

function normalizarCbtesAsoc(cbtesAsoc, cuitEmisor) {
    if (!cbtesAsoc) return undefined;

    const lista = Array.isArray(cbtesAsoc) ? cbtesAsoc : [cbtesAsoc];
    const mapped = lista
        .map((c) => {
            const Tipo = parseInt(c.Tipo ?? c.tipo ?? c.CbteTipo ?? c.tipfac, 10);
            const PtoVta = parseInt(c.PtoVta ?? c.ptoVta ?? c.ptovta, 10);
            const Nro = parseInt(c.Nro ?? c.nro ?? c.CbteNro ?? c.cbteNro, 10);
            if (!Tipo || !PtoVta || !Nro) return null;

            const item = { Tipo, PtoVta, Nro };
            const cuitAsoc = String(c.Cuit ?? c.cuit ?? cuitEmisor ?? '').replace(/[-\s]/g, '');
            if (/^\d{11}$/.test(cuitAsoc)) item.Cuit = cuitAsoc;
            const fch = c.CbteFch ?? c.cbteFch ?? c.fecha;
            if (fch) item.CbteFch = String(fch).replace(/-/g, '');
            return item;
        })
        .filter(Boolean);

    return mapped.length ? mapped : undefined;
}

async function generarFactura(cuitEmisor, datosFactura) {
    try {
        const { token, sign } = await obtenerTokenSign('wsfe');
        const client = await soap.createClientAsync(WSDL_WSFE, { disableCache: true });

        if (!Array.isArray(datosFactura.FeDetReq) || datosFactura.FeDetReq.length !== datosFactura.FeCabReq.CantReg) {
            throw new Error(`FeDetReq debe ser un array con exactamente ${datosFactura.FeCabReq.CantReg} elementos.`);
        }

        const request = {
            Auth: {
                Token: token,
                Sign: sign,
                Cuit: cuitEmisor,
            },
            FeCAEReq: {
                FeCabReq: {
                    CantReg: datosFactura.FeCabReq.CantReg,
                    PtoVta: datosFactura.FeCabReq.PtoVta,
                    CbteTipo: datosFactura.FeCabReq.CbteTipo,
                },
                FeDetReq: {
                    FECAEDetRequest: datosFactura.FeDetReq.map((det) => {
                        const condicionId = resolverCondicionIvaReceptorId(
                            datosFactura.FeCabReq.CbteTipo,
                            det.DocTipo,
                            det.CondicionIVAReceptorId
                        );

                        const payload = {
                            Concepto: det.Concepto,
                            DocTipo: det.DocTipo,
                            DocNro: det.DocNro,
                            CbteDesde: det.CbteDesde,
                            CbteHasta: det.CbteHasta,
                            CbteFch: det.CbteFch,
                            ImpTotal: det.ImpTotal,
                            ImpTotConc: det.ImpTotConc,
                            ImpNeto: det.ImpNeto,
                            ImpOpEx: det.ImpOpEx,
                            ImpTrib: det.ImpTrib,
                            ImpIVA: det.ImpIVA,
                            MonId: det.MonId,
                            MonCotiz: det.MonCotiz,
                            CondicionIVAReceptorId: condicionId,
                            Iva: det.Iva ? { AlicIva: det.Iva } : undefined,
                        };

                        const asociados = normalizarCbtesAsoc(det.CbtesAsoc || det.cbtesAsoc, cuitEmisor);
                        if (asociados) {
                            payload.CbtesAsoc = { CbteAsoc: asociados };
                        }

                        return payload;
                    }),
                },
            },
        };

        const [response] = await client.FECAESolicitarAsync(request);
        return response;
    } catch (error) {
        if (error.afip) throw error;
        const afipErr = extraerErrorAfip(error);
        if (afipErr) throw new AfipError(afipErr.code, afipErr.message);
        throw error;
    }
}

async function consultarConstancia(cuitConsulta, cuitRepresentada) {
    try {
        const { token, sign } = await obtenerTokenSign('ws_sr_constancia_inscripcion');
        const client = await soap.createClientAsync(WSDL_CONSTANCIA);

        const args = {
            token,
            sign,
            cuitRepresentada: cuitRepresentada || cuitConsulta,
            idPersona: cuitConsulta,
        };

        const [result] = await client.getPersona_v2Async(args);

        if (!result || !result.personaReturn) {
            throw new AfipError(null, 'No se encontraron datos del contribuyente');
        }

        return result;
    } catch (error) {
        if (error.afip) throw error;
        const afipErr = extraerErrorAfip(error);
        if (afipErr) throw new AfipError(afipErr.code, afipErr.message);
        throw new AfipError(null, error.message || 'Error al consultar datos del contribuyente en AFIP');
    }
}

/** Arma el payload FE (factura / NC / ND). Monto con IVA 21% incluido. */
function armarComprobante({
    cuit,
    ptoVta,
    monto,
    tipfac = 6,
    doctipo = 99,
    docnro = 0,
    condicionIva,
    cbtesAsoc,
    asociado,
    alicuota = 21,
}) {
    const tipFacNum = parseInt(tipfac, 10);
    const tipo = getTipoComprobante(tipFacNum);
    if (!tipo) {
        throw new AfipError(null, `Tipo de comprobante no soportado: ${tipfac}`);
    }

    const montoNum = parseFloat(monto);
    const factor = 1 + Number(alicuota) / 100;
    const esClaseC = tipo.clase === 'C';

    // Factura C: monotributo / exento — sin discriminación de IVA en el WSFE típico
    let neto;
    let iva;
    let ivaAlic;
    if (esClaseC) {
        neto = parseFloat(montoNum.toFixed(2));
        iva = 0;
        ivaAlic = undefined;
    } else {
        neto = parseFloat((montoNum / factor).toFixed(2));
        iva = parseFloat((montoNum - neto).toFixed(2));
        ivaAlic = [{ Id: 5, BaseImp: neto, Importe: iva }]; // Id 5 = 21%
    }

    const fecha = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const docTipoNum = parseInt(doctipo, 10);
    const condicion =
        condicionIva !== undefined && condicionIva !== null && condicionIva !== ''
            ? parseInt(condicionIva, 10)
            : resolverCondicionIvaReceptorId(tipFacNum, docTipoNum, null);

    let asociados = normalizarCbtesAsoc(cbtesAsoc, cuit);
    if (!asociados && asociado) {
        asociados = normalizarCbtesAsoc(
            [
                {
                    tipo: asociado.tipo ?? asociado.tipfac ?? facturaAsociadaSugerida(tipFacNum),
                    ptoVta: asociado.ptoVta ?? ptoVta,
                    nro: asociado.nro ?? asociado.cbteNro,
                    cuit: asociado.cuit ?? cuit,
                    fecha: asociado.fecha ?? asociado.cbteFch,
                },
            ],
            cuit
        );
    }

    if (esNotaCreditoODebito(tipFacNum) && (!asociados || asociados.length === 0)) {
        throw new AfipError(
            null,
            'Notas de crédito/débito requieren comprobante asociado (asociado o cbtesAsoc)'
        );
    }

    const det = {
        Concepto: 1,
        DocTipo: docTipoNum,
        DocNro: docTipoNum === 99 ? 0 : parseInt(docnro, 10),
        CbteFch: fecha,
        ImpTotal: montoNum,
        ImpTotConc: 0,
        ImpNeto: neto,
        ImpOpEx: 0,
        ImpTrib: 0,
        ImpIVA: iva,
        MonId: 'PES',
        MonCotiz: 1,
        CondicionIVAReceptorId: condicion,
    };

    if (ivaAlic) det.Iva = ivaAlic;
    if (asociados) det.CbtesAsoc = asociados;

    return {
        cuit: String(cuit).replace(/[-\s]/g, ''),
        tipo,
        montos: { montoTotal: montoNum, montoNeto: neto, montoIVA: iva },
        datosFactura: {
            FeCabReq: {
                CbteTipo: tipFacNum,
                CantReg: 1,
                PtoVta: parseInt(ptoVta, 10),
            },
            FeDetReq: [det],
        },
    };
}

/** Compat: Factura B consumidor final. */
function armarFacturaConsumidorFinal(opts) {
    return armarComprobante({
        tipfac: 6,
        doctipo: 99,
        docnro: 0,
        condicionIva: 5,
        ...opts,
    });
}

module.exports = {
    AfipError,
    extraerErrorAfip,
    TIPOS_COMPROBANTE,
    TIPOS_COMPROBANTE_IDS,
    getTipoComprobante,
    esNotaCreditoODebito,
    facturaAsociadaSugerida,
    listarTiposComprobante,
    generarFactura,
    getLastVoucher,
    getNextVoucherNumber,
    createNextVoucher,
    consultarComprobante,
    consultarConstancia,
    consultarCondicionIvaReceptor,
    armarComprobante,
    armarFacturaConsumidorFinal,
    resolverCondicionIvaReceptorId,
    normalizarCbtesAsoc,
};
