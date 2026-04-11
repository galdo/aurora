/**
 * DLNA **Media Server** plane: HTTP (device description, SCPD, streams, covers), SSDP discovery, icons.
 * Renderer SOAP control and GENA callbacks remain in {@link DlnaService}; routes delegate via {@link DlnaMediaServerDeps}.
 */
/* eslint-disable @typescript-eslint/no-use-before-define -- helpers grouped by concern; reordering would split SSDP/HTTP pairs */
import fs from 'fs';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import dgram from 'dgram';
import os from 'os';
import sharp from 'sharp';

import type { DlnaMediaServerDeps } from './dlna-media-server.types';

const debug = require('debug')('aurora:service:dlna:media');

function getRequestPath(requestUrl: string): string {
  try {
    return new URL(requestUrl, 'http://127.0.0.1').pathname;
  } catch (_error) {
    const [pathWithoutQuery] = requestUrl.split('?');
    return pathWithoutQuery || '/';
  }
}

function getRequestBaseUrl(deps: DlnaMediaServerDeps, request: IncomingMessage): string {
  const host = String(request.headers.host || '').trim();
  if (host) {
    return `http://${host}`;
  }
  const localAddress = String(request.socket.localAddress || '').replace(/^::ffff:/, '');
  const localPort = request.socket.localPort || deps.port;
  if (localAddress && localAddress !== '0.0.0.0' && localAddress !== '::') {
    return `http://${localAddress}:${localPort}`;
  }
  const ipAddress = deps.getIpAddresses()[0] || '127.0.0.1';
  return `http://${ipAddress}:${deps.port}`;
}

function hasSameIPv4Subnet(firstAddress: string, secondAddress: string): boolean {
  const firstParts = firstAddress.split('.').map(Number);
  const secondParts = secondAddress.split('.').map(Number);
  if (firstParts.length !== 4 || secondParts.length !== 4) {
    return false;
  }
  return firstParts[0] === secondParts[0]
    && firstParts[1] === secondParts[1]
    && firstParts[2] === secondParts[2];
}

function getDescriptionUrlForIp(deps: DlnaMediaServerDeps, ipAddress: string, profile: 'v1' | 'v2' = 'v1') {
  const descriptionPath = profile === 'v2' ? '/upnp/description-v2.xml' : '/description.xml';
  return `http://${ipAddress}:${deps.port}${descriptionPath}`;
}

function getDescriptionUrlForClient(deps: DlnaMediaServerDeps, clientAddress: string, profile: 'v1' | 'v2' = 'v1') {
  const ipAddresses = deps.getIpAddresses();
  const matchingSubnetIp = ipAddresses.find(ipAddress => hasSameIPv4Subnet(ipAddress, clientAddress));
  return getDescriptionUrlForIp(deps, matchingSubnetIp || ipAddresses[0] || '127.0.0.1', profile);
}

function extractSsdpHeaderValue(message: string, headerName: string) {
  const escaped = String(headerName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = message.match(new RegExp(`^${escaped}\\s*:\\s*(.+)\\r?$`, 'im'));
  if (!match) {
    const lines = String(message || '').split(/\r?\n/);
    const lower = String(headerName || '').toLowerCase();
    const line = lines.find(l => l.toLowerCase().startsWith(`${lower}:`));
    if (!line) {
      return '';
    }
    const value = line.replace(/^[^:]+:\s*/, '');
    return String(value || '').trim();
  }
  return String(match[1] || '').trim();
}

function writeXml(response: ServerResponse, xml: string) {
  response.writeHead(200, {
    'Content-Type': 'application/xml; charset="utf-8"',
    'Cache-Control': 'no-cache',
  });
  response.end(xml);
}

function handleSsdpMessage(deps: DlnaMediaServerDeps, message: string, address: string, port: number) {
  const normalizedMessage = message.toUpperCase();
  if (!normalizedMessage.includes('M-SEARCH')) {
    return;
  }
  const lower = message.toLowerCase();
  const hasDiscover = lower.includes('ssdp:discover')
    || /man\s*:\s*"?\s*ssdp:discover\s*"?/i.test(message);
  if (!hasDiscover) {
    return;
  }
  const searchTarget = extractSsdpHeaderValue(message, 'ST') || 'ssdp:all';
  const searchTargetNormalized = searchTarget.toLowerCase();
  const supportedTargets = [
    'ssdp:all',
    'upnp:rootdevice',
    deps.rootDeviceUdn.toLowerCase(),
    deps.serviceType.toLowerCase(),
    deps.upnpMediaServerV2ServiceType.toLowerCase(),
    deps.contentDirectoryServiceType.toLowerCase(),
    deps.connectionManagerServiceType.toLowerCase(),
  ];
  if (!supportedTargets.includes(searchTargetNormalized)) {
    return;
  }
  const mxRaw = Number(extractSsdpHeaderValue(message, 'MX') || 2);
  const mxSeconds = Math.max(0.1, Math.min(5, Number.isFinite(mxRaw) ? mxRaw : 2));
  const delayMs = Math.floor(Math.random() * mxSeconds * 1000);
  setTimeout(() => {
    const location = getDescriptionUrlForClient(deps, address);
    const responseTargets = searchTargetNormalized === 'ssdp:all'
      ? [
        'upnp:rootdevice',
        deps.rootDeviceUdn,
        deps.serviceType,
        deps.upnpMediaServerV2ServiceType,
        deps.contentDirectoryServiceType,
        deps.connectionManagerServiceType,
      ]
      : [searchTarget];
    responseTargets.forEach((responseTarget) => {
      const isV2Target = String(responseTarget || '').toLowerCase() === deps.upnpMediaServerV2ServiceType.toLowerCase();
      const targetLocation = isV2Target
        ? getDescriptionUrlForClient(deps, address, 'v2')
        : location;
      sendSsdpSearchResponse(deps, responseTarget, targetLocation, address, port);
    });
  }, delayMs);
}

function sendSsdpSearchResponse(
  deps: DlnaMediaServerDeps,
  responseTarget: string,
  location: string,
  address: string,
  port: number,
) {
  const responseTargetNormalized = responseTarget.toLowerCase();
  let responseUsn = deps.usn;
  if (responseTargetNormalized === 'upnp:rootdevice') {
    responseUsn = `${deps.rootDeviceUdn}::upnp:rootdevice`;
  } else if (responseTargetNormalized === deps.rootDeviceUdn.toLowerCase()) {
    responseUsn = deps.rootDeviceUdn;
  } else if (
    responseTargetNormalized === deps.contentDirectoryServiceType.toLowerCase()
    || responseTargetNormalized === deps.connectionManagerServiceType.toLowerCase()
    || responseTargetNormalized === deps.upnpMediaServerV2ServiceType.toLowerCase()
  ) {
    responseUsn = `${deps.rootDeviceUdn}::${responseTarget}`;
  }
  const responseLines = [
    'HTTP/1.1 200 OK',
    `DATE: ${new Date().toUTCString()}`,
    `CACHE-CONTROL: max-age=${deps.ssdpMaxAgeSeconds}`,
    'EXT:',
    `LOCATION: ${location}`,
    'BOOTID.UPNP.ORG: 1',
    'CONFIGID.UPNP.ORG: 1',
    'SERVER: AuroraPulse/2.0 UPnP/1.1 DLNADOC/1.50',
    `ST: ${responseTarget}`,
    `USN: ${responseUsn}`,
    '\r\n',
  ];
  deps.getSsdpSocket()?.send(responseLines.join('\r\n'), port, address);
}

function sendSsdpNotify(deps: DlnaMediaServerDeps) {
  const notificationDefinitions = [
    {
      nt: 'upnp:rootdevice',
      usn: `${deps.rootDeviceUdn}::upnp:rootdevice`,
    },
    {
      nt: deps.rootDeviceUdn,
      usn: deps.rootDeviceUdn,
    },
    {
      nt: deps.serviceType,
      usn: deps.usn,
    },
    {
      nt: deps.upnpMediaServerV2ServiceType,
      usn: deps.upnpMediaServerV2Usn,
    },
    {
      nt: deps.contentDirectoryServiceType,
      usn: `${deps.rootDeviceUdn}::${deps.contentDirectoryServiceType}`,
    },
    {
      nt: deps.connectionManagerServiceType,
      usn: `${deps.rootDeviceUdn}::${deps.connectionManagerServiceType}`,
    },
  ];
  deps.getIpAddresses().forEach((ipAddress) => {
    const location = getDescriptionUrlForIp(deps, ipAddress);
    notificationDefinitions.forEach((definition) => {
      const isV2Nt = String(definition.nt || '').toLowerCase() === deps.upnpMediaServerV2ServiceType.toLowerCase();
      const notifyLocation = isV2Nt
        ? getDescriptionUrlForIp(deps, ipAddress, 'v2')
        : location;
      const notifyLines = [
        'NOTIFY * HTTP/1.1',
        `HOST: ${deps.multicastIp}:${deps.multicastPort}`,
        `DATE: ${new Date().toUTCString()}`,
        `CACHE-CONTROL: max-age=${deps.ssdpMaxAgeSeconds}`,
        `LOCATION: ${notifyLocation}`,
        `NT: ${definition.nt}`,
        'NTS: ssdp:alive',
        'BOOTID.UPNP.ORG: 1',
        'CONFIGID.UPNP.ORG: 1',
        'SERVER: AuroraPulse/2.0 UPnP/1.1 DLNADOC/1.50',
        `USN: ${definition.usn}`,
        '\r\n',
      ];
      deps.getSsdpSocket()?.send(notifyLines.join('\r\n'), deps.multicastPort, deps.multicastIp);
    });
  });
}

function sendSsdpByeBye(deps: DlnaMediaServerDeps) {
  if (!deps.getSsdpSocket()) {
    return;
  }
  const notificationDefinitions = [
    {
      nt: 'upnp:rootdevice',
      usn: `${deps.rootDeviceUdn}::upnp:rootdevice`,
    },
    {
      nt: deps.rootDeviceUdn,
      usn: deps.rootDeviceUdn,
    },
    {
      nt: deps.serviceType,
      usn: deps.usn,
    },
    {
      nt: deps.upnpMediaServerV2ServiceType,
      usn: deps.upnpMediaServerV2Usn,
    },
    {
      nt: deps.contentDirectoryServiceType,
      usn: `${deps.rootDeviceUdn}::${deps.contentDirectoryServiceType}`,
    },
    {
      nt: deps.connectionManagerServiceType,
      usn: `${deps.rootDeviceUdn}::${deps.connectionManagerServiceType}`,
    },
  ];
  notificationDefinitions.forEach((definition) => {
    const byebyeLines = [
      'NOTIFY * HTTP/1.1',
      `HOST: ${deps.multicastIp}:${deps.multicastPort}`,
      `NT: ${definition.nt}`,
      'NTS: ssdp:byebye',
      `USN: ${definition.usn}`,
      '\r\n',
    ];
    deps.getSsdpSocket()?.send(byebyeLines.join('\r\n'), deps.multicastPort, deps.multicastIp);
  });
}

export function startSsdpBroadcast(deps: DlnaMediaServerDeps) {
  if (deps.getSsdpSocket()) {
    return;
  }

  deps.setSsdpSocket(dgram.createSocket({ type: 'udp4', reuseAddr: true }));
  const socket = deps.getSsdpSocket()!;
  socket.on('error', (error) => {
    deps.setLastError(String((error as Error)?.message || error));
    const staleSocket = deps.getSsdpSocket();
    deps.setSsdpSocket(undefined);
    if (staleSocket) {
      try {
        staleSocket.close();
      } catch (_closeError) {
        // no-op
      }
    }
    if (deps.getSsdpInterval()) {
      clearInterval(deps.getSsdpInterval()!);
      deps.setSsdpInterval(undefined);
    }
    if (deps.enabled && deps.getHttpServer() && !deps.getSsdpRestartTimeout()) {
      deps.setSsdpRestartTimeout(setTimeout(() => {
        deps.setSsdpRestartTimeout(undefined);
        if (deps.enabled && deps.getHttpServer() && !deps.getSsdpSocket()) {
          startSsdpBroadcast(deps);
        }
      }, deps.ssdpRestartDelayMs));
    }
    deps.emitState();
  });
  socket.on('message', (message, remote) => {
    handleSsdpMessage(deps, message.toString(), remote.address, remote.port);
  });
  socket.bind(deps.multicastPort, () => {
    try {
      const interfaces = os.networkInterfaces();
      const interfaceIps = Object.values(interfaces)
        .flat()
        .filter(Boolean)
        .filter(address => address?.family === 'IPv4' && !address.internal)
        .map(address => String(address?.address || '').trim())
        .filter(Boolean);
      if (interfaceIps.length === 0) {
        deps.getSsdpSocket()?.addMembership(deps.multicastIp);
      } else {
        interfaceIps.forEach((interfaceIp) => {
          try {
            deps.getSsdpSocket()?.addMembership(deps.multicastIp, interfaceIp);
          } catch (error) {
            debug('startSsdpBroadcast addMembership failed for %s - %o', interfaceIp, error);
          }
        });
      }
    } catch (error) {
      debug('startSsdpBroadcast addMembership failed - %o', error);
    }
    deps.getSsdpSocket()?.setMulticastTTL(4);
    deps.getSsdpSocket()?.setMulticastLoopback(false);
    sendSsdpNotify(deps);
    setTimeout(() => sendSsdpNotify(deps), 500);
    setTimeout(() => sendSsdpNotify(deps), 1500);
    deps.setSsdpInterval(setInterval(() => {
      sendSsdpNotify(deps);
    }, deps.notifyIntervalMs));
  });
}

async function streamTrack(deps: DlnaMediaServerDeps, response: ServerResponse, request: IncomingMessage, trackId?: string) {
  if (!trackId) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('No track selected');
    return;
  }

  const track = await deps.resolveStreamTrack(trackId);
  if (!track || !fs.existsSync(track.filePath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Track not available');
    return;
  }

  const rangeHeader = String(request.headers.range || '');
  let startByte = 0;
  let endByte = Math.max(0, track.fileSize - 1);

  if (rangeHeader.startsWith('bytes=')) {
    const [rangeStart, rangeEnd] = rangeHeader.replace('bytes=', '').split('-');
    const parsedStart = Number(rangeStart);
    const parsedEnd = Number(rangeEnd);
    if (Number.isFinite(parsedStart) && parsedStart >= 0) {
      startByte = parsedStart;
    }
    if (Number.isFinite(parsedEnd) && parsedEnd >= startByte) {
      endByte = parsedEnd;
    }
    endByte = Math.min(endByte, Math.max(0, track.fileSize - 1));
  }

  const contentLength = Math.max(0, (endByte - startByte) + 1);
  const partial = rangeHeader.startsWith('bytes=');
  response.writeHead(partial ? 206 : 200, {
    'Content-Type': track.mimeType,
    'Accept-Ranges': 'bytes',
    'Content-Length': contentLength,
    ...(partial ? { 'Content-Range': `bytes ${startByte}-${endByte}/${track.fileSize}` } : {}),
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': deps.getDlnaContentFeaturesForMimeType(track.mimeType),
    'Cache-Control': 'no-cache',
  });
  if (String(request.method || 'GET').toUpperCase() === 'HEAD') {
    response.end();
    return;
  }
  const stream = fs.createReadStream(track.filePath, {
    start: startByte,
    end: endByte,
    highWaterMark: deps.bufferBytes,
  });
  stream.once('error', () => {
    response.destroy();
  });
  stream.pipe(response);
}

async function streamTrackCover(deps: DlnaMediaServerDeps, response: ServerResponse, request: IncomingMessage, trackId?: string) {
  if (!trackId) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('No track selected');
    return;
  }
  const track = await deps.resolveStreamTrack(trackId);
  const coverPath = String(track?.coverPath || '').trim();
  if (!coverPath || !fs.existsSync(coverPath)) {
    deps.writeDlnaLog('warn', 'cover_not_available', {
      trackId,
      hasTrack: !!track,
    });
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Cover not available');
    return;
  }
  const rawCoverBuffer = fs.readFileSync(coverPath);
  const sourceCoverMimeType = deps.getImageMimeType(coverPath) || 'image/jpeg';
  let coverBuffer: Buffer;
  let coverMimeType = 'image/jpeg';
  let coverProfile = deps.getDlnaImageProfileForMimeType();
  try {
    coverBuffer = await sharp(rawCoverBuffer)
      .rotate()
      .resize({
        width: 600,
        height: 600,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 86,
        progressive: false,
        mozjpeg: true,
        chromaSubsampling: '4:2:0',
      })
      .toBuffer();
  } catch (_error) {
    try {
      coverBuffer = await sharp(coverPath)
        .rotate()
        .resize({
          width: 600,
          height: 600,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({
          quality: 86,
          progressive: false,
          mozjpeg: true,
          chromaSubsampling: '4:2:0',
        })
        .toBuffer();
    } catch (error) {
      debug('streamTrackCover sharp conversion failed - %o', error);
      deps.writeDlnaLog('error', 'cover_sharp_conversion_failed', {
        trackId,
        coverPath,
        error: String((error as Error)?.message || error || ''),
      });
      coverBuffer = rawCoverBuffer;
      coverMimeType = sourceCoverMimeType;
      coverProfile = '';
    }
  }
  if (!coverBuffer || coverBuffer.byteLength <= 0) {
    coverBuffer = rawCoverBuffer;
    coverMimeType = sourceCoverMimeType;
    coverProfile = '';
  }
  const coverContentFeatures = coverProfile
    ? `DLNA.ORG_PN=${coverProfile};DLNA.ORG_OP=01;DLNA.ORG_CI=1`
    : 'DLNA.ORG_OP=01';
  const rangeHeader = String(request.headers.range || '');
  const totalLength = coverBuffer.byteLength;
  let startByte = 0;
  let endByte = Math.max(0, totalLength - 1);
  if (rangeHeader.startsWith('bytes=')) {
    const [rangeStart, rangeEnd] = rangeHeader.replace('bytes=', '').split('-');
    const parsedStart = Number(rangeStart);
    const parsedEnd = Number(rangeEnd);
    if (Number.isFinite(parsedStart) && parsedStart >= 0) {
      startByte = Math.floor(parsedStart);
    }
    if (Number.isFinite(parsedEnd) && parsedEnd >= startByte) {
      endByte = Math.floor(parsedEnd);
    }
    endByte = Math.min(endByte, Math.max(0, totalLength - 1));
  }
  const partial = rangeHeader.startsWith('bytes=');
  const contentLength = Math.max(0, (endByte - startByte) + 1);
  response.writeHead(partial ? 206 : 200, {
    'Content-Type': coverMimeType,
    'Content-Length': contentLength,
    'Accept-Ranges': 'bytes',
    ...(partial ? { 'Content-Range': `bytes ${startByte}-${endByte}/${totalLength}` } : {}),
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': coverContentFeatures,
    'Cache-Control': 'public, max-age=3600',
  });
  if (String(request.method || 'GET').toUpperCase() === 'HEAD') {
    response.end();
    return;
  }
  response.end(coverBuffer.subarray(startByte, endByte + 1));
}

function serveIcon(deps: DlnaMediaServerDeps, response: ServerResponse, size: number) {
  const cached = deps.getIconCache().get(size);
  if (cached) {
    response.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': cached.byteLength,
      'Cache-Control': 'public, max-age=86400',
    });
    response.end(cached);
    return;
  }
  sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 74, g: 109, b: 167 },
    },
  })
    .png()
    .toBuffer()
    .then((buffer) => {
      deps.getIconCache().set(size, buffer);
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': buffer.byteLength,
        'Cache-Control': 'public, max-age=86400',
      });
      response.end(buffer);
    })
    .catch(() => {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Icon not available');
    });
}

export function handleMediaServerHttpRequest(deps: DlnaMediaServerDeps, request: IncomingMessage, response: ServerResponse) {
  const requestUrl = String(request.url || '/');
  const requestPath = getRequestPath(requestUrl);
  deps.writeDlnaLog('info', 'http_request_received', {
    method: String(request.method || 'GET').toUpperCase(),
    path: requestPath,
    rawUrl: requestUrl,
    userAgent: String(request.headers['user-agent'] || ''),
    range: String(request.headers.range || ''),
    host: String(request.headers.host || ''),
    dlnaLayer: 'dlna.media_server',
  });
  if (requestPath === '/description.xml') {
    const clientHost = getRequestBaseUrl(deps, request);
    writeXml(response, deps.getDescriptionXml('v1', clientHost));
    return;
  }
  if (requestPath === '/upnp/description-v2.xml') {
    const clientHost = getRequestBaseUrl(deps, request);
    writeXml(response, deps.getDescriptionXml('v2', clientHost));
    return;
  }
  if (requestPath === '/upnp/content-directory.xml') {
    writeXml(response, deps.getContentDirectoryScpdXml());
    return;
  }
  if (requestPath === '/upnp/connection-manager.xml') {
    writeXml(response, deps.getConnectionManagerScpdXml());
    return;
  }
  if (requestPath === '/upnp/control/content-directory') {
    deps.handleContentDirectoryControlRequest(request, response);
    return;
  }
  if (requestPath === '/upnp/control/connection-manager') {
    deps.handleConnectionManagerControlRequest(request, response);
    return;
  }
  if (requestPath === '/upnp/event/renderer') {
    deps.handleRendererEventCallbackRequest(request, response);
    return;
  }
  if (requestPath === '/upnp/event/rendering-control') {
    deps.handleRenderingControlEventCallbackRequest(request, response);
    return;
  }
  if (requestPath === '/icon-48.png' || requestPath === '/icon-120.png') {
    serveIcon(deps, response, requestPath === '/icon-120.png' ? 120 : 48);
    return;
  }
  if (requestPath === '/content.xml') {
    writeXml(response, deps.getContentXml());
    return;
  }
  if (requestPath === '/status.json') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(deps.getServerStateJson()));
    return;
  }
  if (requestPath.startsWith('/stream/')) {
    const trackId = decodeURIComponent(requestPath.replace('/stream/', ''));
    streamTrack(deps, response, request, trackId === 'current' ? deps.getCurrentTrackId() : trackId).catch((error) => {
      debug('streamTrack failed - %o', error);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Stream failed');
      }
    });
    return;
  }
  if (requestPath.startsWith('/cover/')) {
    const rawTrackId = decodeURIComponent(requestPath.replace('/cover/', ''));
    const trackId = rawTrackId.replace(/\.(jpg|jpeg|png|webp)$/i, '');
    streamTrackCover(deps, response, request, trackId === 'current' ? deps.getCurrentTrackId() : trackId).catch((error) => {
      debug('streamTrackCover failed - %o', error);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Cover failed');
      }
    });
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}

export async function startMediaServer(deps: DlnaMediaServerDeps): Promise<void> {
  if (deps.getHttpServer()) {
    deps.emitState();
    return;
  }

  deps.setLastError(undefined);
  try {
    deps.setHttpServer(http.createServer((request, response) => {
      handleMediaServerHttpRequest(deps, request, response);
    }));
    await new Promise<void>((resolve, reject) => {
      deps.getHttpServer()?.once('error', reject);
      deps.getHttpServer()?.listen(deps.port, '0.0.0.0', () => {
        deps.getHttpServer()?.off('error', reject);
        resolve();
      });
    });
    startSsdpBroadcast(deps);
    deps.refreshBrowseLibrary().catch((error) => {
      debug('refreshBrowseLibrary initial call failed - %o', error);
    });
  } catch (error: unknown) {
    deps.setLastError(String((error as Error)?.message || error));
    debug('startServer failed - %o', error);
    await stopMediaServer(deps);
  }
  deps.emitState();
}

/** Closes SSDP + HTTP listeners (no SSDP bye-bye — use {@link stopMediaServer} for a full shutdown). */
export async function stopMediaServerSocketsAndHttp(deps: DlnaMediaServerDeps): Promise<void> {
  if (deps.getSsdpRestartTimeout()) {
    clearTimeout(deps.getSsdpRestartTimeout()!);
    deps.setSsdpRestartTimeout(undefined);
  }
  if (deps.getSsdpInterval()) {
    clearInterval(deps.getSsdpInterval()!);
    deps.setSsdpInterval(undefined);
  }
  if (deps.getSsdpSocket()) {
    try {
      deps.getSsdpSocket()?.close();
    } catch (error) {
      debug('stopServer close ssdp failed - %o', error);
    }
    deps.setSsdpSocket(undefined);
  }
  if (deps.getHttpServer()) {
    const serverRef = deps.getHttpServer()!;
    deps.setHttpServer(undefined);
    await new Promise<void>((resolve) => {
      serverRef.close(() => resolve());
    });
  }
}

/**
 * SSDP bye-bye, optional hook (e.g. stop renderer event renewal), then socket + HTTP teardown.
 */
export async function stopMediaServer(deps: DlnaMediaServerDeps, afterSsdpByeBye?: () => void): Promise<void> {
  sendSsdpByeBye(deps);
  afterSsdpByeBye?.();
  await stopMediaServerSocketsAndHttp(deps);
}

export const DlnaMediaServer = {
  start: startMediaServer,
  stop: stopMediaServer,
  stopSocketsAndHttp: stopMediaServerSocketsAndHttp,
  handleHttpRequest: handleMediaServerHttpRequest,
  startSsdpBroadcast,
};
