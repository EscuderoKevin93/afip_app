const fs = require('fs');
const path = require('path');
const soap = require('soap');
const forge = require('node-forge');
const xml2js = require('xml2js');
const moment = require('moment-timezone');

// Configuración de logging
const logInfo = (message, data = null) => {
    // No hacer nada, solo para mantener la compatibilidad
};

const logError = (message, error = null) => {
    // No hacer nada, solo para mantener la compatibilidad
};

// Configuración
const PRIVATE_KEY_PATH = path.join(__dirname, '/certs/key.key');
const CERT_PATH = path.join(__dirname, '/certs/cert.crt');
const WSAA_WSDL = path.join(__dirname, './wsaa.wsdl');
const WSAA_URL = 'https://wsaa.afip.gov.ar/ws/services/LoginCms';
const WSDL_WSFE = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL';
const WSDL_CONSTANCIA = 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5?WSDL';

// Cache para tokens
const tokenCache = new Map();
const TOKEN_CACHE_DURATION = 11 * 60 * 1000; // 11 minutos en milisegundos

// Función para limpiar el caché de tokens expirados
const cleanExpiredTokens = () => {
    const now = Date.now();
    for (const [key, value] of tokenCache.entries()) {
        if (now - value.timestamp > TOKEN_CACHE_DURATION) {
            tokenCache.delete(key);
            logInfo(`Token expirado eliminado para servicio: ${key}`);
        }
    }
};

// Limpiar caché cada minuto
setInterval(cleanExpiredTokens, 60000);

// Función para limpiar el caché de tokens
function limpiarCacheTokens() {
    logInfo('Limpiando caché de tokens');
    tokenCache.clear();
}

// Función para manejar errores de autenticación
async function manejarErrorAutenticacion(error, service) {
    if (error.message && error.message.includes('alreadyAuthenticated')) {
        logInfo('Error de autenticación existente detectado, limpiando caché y reintentando');
        limpiarCacheTokens();
        return await obtenerTokenSign(service);
    }
    throw error;
}

// Generar CMS firmado
function crearCMS(service) {
    try {
        logInfo(`Generando CMS para servicio: ${service}`);
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

        const cms = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary').toString('base64');
        logInfo('CMS generado exitosamente');
        return cms;
    } catch (error) {
        logError('Error al crear CMS:', error);
        throw new Error('Error al generar el ticket de autenticación');
    }
}

// Obtener Token y Sign con caché
async function obtenerTokenSign(service) {
    logInfo(`Solicitando token para servicio: ${service}`);
    
    const cachedToken = tokenCache.get(service);
    if (cachedToken && Date.now() - cachedToken.timestamp < TOKEN_CACHE_DURATION) {
        logInfo(`Usando token en caché para servicio: ${service}`);
        return cachedToken.credentials;
    }

    try {
        // Intentar obtener el token existente primero
        const cms = crearCMS(service);
        logInfo('Creando cliente SOAP para WSAA');
        const client = await soap.createClientAsync(WSAA_WSDL, { endpoint: WSAA_URL });
        
        logInfo('Solicitando login a WSAA');
        try {
            const [result] = await client.loginCmsAsync({ in0: cms });
            logInfo('Parseando respuesta de WSAA');
            const parser = new xml2js.Parser({ explicitArray: false });
            const parsed = await parser.parseStringPromise(result.loginCmsReturn);

            const credentials = parsed.loginTicketResponse?.credentials;
            if (!credentials || !credentials.token || !credentials.sign) {
                logError('Respuesta de WSAA inválida', parsed);
                throw new Error('No se encontraron las credenciales en la respuesta del WSAA');
            }

            // Guardar en caché
            tokenCache.set(service, {
                credentials,
                timestamp: Date.now()
            });

            logInfo('Token obtenido y guardado en caché exitosamente');
            return credentials;
        } catch (error) {
            // Si el error es de autenticación existente, intentar extraer el token
            if (error.message && error.message.includes('alreadyAuthenticated')) {
                logInfo('Token ya autenticado detectado, intentando extraer credenciales');
                try {
                    // Intentar obtener el token del error
                    const errorResponse = error.root?.Envelope?.Body?.Fault?.detail;
                    if (errorResponse) {
                        const credentials = {
                            token: errorResponse.token,
                            sign: errorResponse.sign
                        };
                        
                        // Guardar en caché
                        tokenCache.set(service, {
                            credentials,
                            timestamp: Date.now()
                        });

                        logInfo('Token extraído exitosamente del error de autenticación');
                        return credentials;
                    }
                } catch (extractError) {
                    logError('Error al extraer token del error:', extractError);
                }
            }
            throw error;
        }
    } catch (error) {
        logError('Error al autenticar con WSAA:', error);
        throw new Error('Error de autenticación con AFIP');
    }
}

async function getLastVoucher(salesPoint, type) {
    try {
        const { token, sign } = await obtenerTokenSign('wsfe');
        
        const client = await soap.createClientAsync(WSDL_WSFE);
        
        const args = {
            Auth: {
                Token: token,
                Sign: sign,
                Cuit: process.env.AFIP_CUIT,
            },
            PtoVta: salesPoint,
            CbteTipo: type,
        };

        const [response] = await client.FECompUltimoAutorizadoAsync(args);
        
        if (!response || !response.FECompUltimoAutorizadoResult) {
            throw new Error('No se pudo obtener el último comprobante autorizado');
        }
        
        return response.FECompUltimoAutorizadoResult.CbteNro;
    } catch (error) {
        if (error.message && error.message.includes('alreadyAuthenticated')) {
            return await manejarErrorAutenticacion(error, 'wsfe');
        }
        throw error;
    }
}

async function createNextVoucher(data) {
    try {
        const lastVoucher = await getLastVoucher(data.FeCabReq.PtoVta, data.FeCabReq.CbteTipo);
        const voucherNumber = lastVoucher + 1;

        data.FeDetReq[0].CbteDesde = voucherNumber;
        data.FeDetReq[0].CbteHasta = voucherNumber;

        const factura = await generarFactura(process.env.AFIP_CUIT, data);

        const detalleRespuesta = factura.FECAESolicitarResult?.FeDetResp?.FECAEDetResponse;
        if (!detalleRespuesta || detalleRespuesta.length === 0) {
            throw new Error('No se encontró la respuesta de detalle en FeDetResp');
        }

        return {
            CAE: detalleRespuesta[0].CAE,
            CAEFchVto: detalleRespuesta[0].CAEFchVto,
            voucherNumber: voucherNumber,
        };
    } catch (error) {
        if (error.message && error.message.includes('alreadyAuthenticated')) {
            return await manejarErrorAutenticacion(error, 'wsfe');
        }
        throw error;
    }
}

async function consultarCondicionIvaReceptor(claseComprobante = null) {
    try {
        const { token, sign } = await obtenerTokenSign('wsfe');
        
        const client = await soap.createClientAsync(WSDL_WSFE);

        const req = {
            Auth: {
                Token: token,
                Sign: sign,
                Cuit: process.env.AFIP_CUIT,
            }
        };

        // Agregar clase de comprobante si se proporciona
        if (claseComprobante) {
            req.ClaseCmp = claseComprobante;
        }

        const [response] = await client.FEParamGetCondicionIvaReceptorAsync(req);

        if (!response || !response.FEParamGetCondicionIvaReceptorResult) {
            throw new Error('Error al obtener la condición IVA del receptor. Respuesta no válida.');
        }

        const result = response.FEParamGetCondicionIvaReceptorResult;
        
        // Verificar si hay errores
        if (result.Errors && result.Errors.Err && result.Errors.Err.length > 0) {
            const error = result.Errors.Err[0];
            throw new Error(`Error de AFIP: ${error.Code} - ${error.Msg}`);
        }

        // Validar que tenemos condiciones IVA
        if (!result.ResultGet || !result.ResultGet.CondicionIvaReceptor || result.ResultGet.CondicionIvaReceptor.length === 0) {
            throw new Error('No se encontraron condiciones IVA para el receptor');
        }

        // Mapear las condiciones IVA a un formato más útil
        const condicionesIva = result.ResultGet.CondicionIvaReceptor.map(condicion => ({
            Id: condicion.Id,
            Desc: condicion.Desc,
            Cmp_Clase: condicion.Cmp_Clase,
            FechaDesde: condicion.FechaDesde,
            FechaHasta: condicion.FechaHasta
        }));

        return condicionesIva;
    } catch (error) {
        if (error.message && error.message.includes('alreadyAuthenticated')) {
            return await manejarErrorAutenticacion(error, 'wsfe');
        }
        throw error;
    }
}

async function generarFactura(cuitEmisor, datosFactura) {
    try {
        // Obtener la condición IVA del receptor
        const claseComprobante = datosFactura.FeCabReq.CbteTipo === 1 ? 'A' : 'B';
        const condicionesIva = await consultarCondicionIvaReceptor(claseComprobante);
        
        // Verificar si el receptor tiene una condición IVA válida para el tipo de comprobante
        const receptorValido = condicionesIva.some(condicion => 
            condicion.Cmp_Clase === claseComprobante
        );
        
        if (!receptorValido) {
            throw new Error(`El receptor no tiene una condición IVA válida para comprobantes tipo ${claseComprobante}`);
        }

        // Obtener la condición IVA específica del receptor y verificar su vigencia
        const condicionIvaReceptor = condicionesIva.find(condicion => 
            condicion.Cmp_Clase === claseComprobante
        );

        // Verificar vigencia de la condición IVA
        const fechaActual = new Date();
        if (condicionIvaReceptor.FechaHasta && new Date(condicionIvaReceptor.FechaHasta) < fechaActual) {
            throw new Error(`La condición IVA del receptor ha expirado el ${condicionIvaReceptor.FechaHasta}`);
        }
        
        const { token, sign } = await obtenerTokenSign('wsfe');
        
        const client = await soap.createClientAsync(WSDL_WSFE, { disableCache: true });

        if (!Array.isArray(datosFactura.FeDetReq) || datosFactura.FeDetReq.length !== datosFactura.FeCabReq.CantReg) {
            throw new Error(`FeDetReq debe ser un array con exactamente ${datosFactura.FeCabReq.CantReg} elementos.`);
        }

        const auth = {
            Token: token,
            Sign: sign,
            Cuit: cuitEmisor,
        };

        const request = {
            Auth: auth,
            FeCAEReq: {
                FeCabReq: {
                    CantReg: datosFactura.FeCabReq.CantReg,
                    PtoVta: datosFactura.FeCabReq.PtoVta,
                    CbteTipo: datosFactura.FeCabReq.CbteTipo,
                },
                FeDetReq: {
                    FECAEDetRequest: datosFactura.FeDetReq.map(det => ({
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
                        Iva: det.Iva ? { AlicIva: det.Iva } : undefined,
                        // Agregar la condición IVA del receptor
                        CondicionIvaReceptor: {
                            Id: condicionIvaReceptor.Id,
                            Desc: condicionIvaReceptor.Desc
                        }
                    })),
                },
            },
        };

        const [response] = await client.FECAESolicitarAsync(request);
        return response;
    } catch (error) {
        throw error;
    }
}

async function consultarConstancia(cuit) {
    logInfo(`Consultando constancia para CUIT: ${cuit}`);
    try {
        const { token, sign } = await obtenerTokenSign('ws_sr_constancia_inscripcion');
        
        logInfo('Creando cliente SOAP para consulta de constancia');
        const client = await soap.createClientAsync(WSDL_CONSTANCIA);
        
        const args = {
            token,
            sign,
            cuitRepresentada: process.env.AFIP_CUIT,
            idPersona: cuit,
        };

        logInfo('Enviando solicitud de constancia', args);
        const [result] = await client.getPersona_v2Async(args);
        
        if (!result || !result.personaReturn) {
            logError('Respuesta de constancia inválida', result);
            throw new Error('No se encontraron datos del contribuyente');
        }
        
        logInfo('Constancia obtenida exitosamente', result.personaReturn);
        return result;
    } catch (error) {
        logError('Error al consultar constancia:', error);
        throw new Error('Error al consultar datos del contribuyente en AFIP');
    }
}

module.exports = { 
    generarFactura, 
    getLastVoucher, 
    createNextVoucher, 
    consultarConstancia,
    consultarCondicionIvaReceptor 
};

