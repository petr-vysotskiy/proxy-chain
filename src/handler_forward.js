import http from 'http';
import {
    isHopByHopHeader, isInvalidHeader, addHeader, maybeAddProxyAuthorizationHeader,
} from './tools';
import HandlerBase from './handler_base';
import { RequestError } from './server';
import tls from 'tls';

/**
 * Represents a proxied request to a HTTP server, either direct or via another upstream proxy.
 */
export default class HandlerForward extends HandlerBase {
    constructor(options) {
        super(options);

        this.bindHandlersToThis(['onTrgResponse', 'onTrgError']);
    }

    run() {
        this.createTunnel();
    }

    createTunnel() {
        const tlsSocket = tls.connect({
            host: this.upstreamProxyUrlParsed.hostname,
            port: this.upstreamProxyUrlParsed.port
        });

        const headers = { ...this.proxyHeaders };
        const [requestHost, requestPort] = this.srcRequest.url.split(':');
        const requestUrl = `${requestHost}:${requestPort || '80'}`;
        let payload = `CONNECT ${requestUrl} HTTP/1.1\r\n`;

        headers.Host = requestUrl;

        headers.Connection = 'close';
        for (const name of Object.keys(headers)) {
            payload += `${name}: ${headers[name]}\r\n`;
        }

        const proxyResponsePromise = this.parseProxyResponse(tlsSocket);

        tlsSocket.write(`${payload}\r\n`);

        proxyResponsePromise.then(({ statusCode }) => {
            this.forwardRequest(statusCode === 200 && tlsSocket);
        });
    }

    parseProxyResponse(socket) {
        return new Promise((resolve, reject) => {
            // we need to buffer any HTTP traffic that happens with the proxy before we get
            // the CONNECT response, so that if the response is anything other than an "200"
            // response code, then we can re-play the "data" events on the socket once the
            // HTTP parser is hooked up...
            let buffersLength = 0;
            const buffers = [];

            function read() {
                const b = socket.read();
                if (b) ondata(b);
                else socket.once('readable', read);
            }

            function cleanup() {
                socket.removeListener('end', onend);
                socket.removeListener('error', onerror);
                socket.removeListener('close', onclose);
                socket.removeListener('readable', read);
            }

            function onclose(err) {
                console.log(('onclose had error %o', err));
            }

            function onend() {
                console.log(('onend'));
            }

            function onerror(err) {
                cleanup();
                console.log(('onerror %o', err));
                reject(err);
            }

            function ondata(b) {
                buffers.push(b);
                buffersLength += b.length;

                const buffered = Buffer.concat(buffers, buffersLength);
                const endOfHeaders = buffered.indexOf('\r\n\r\n');

                if (endOfHeaders === -1) {
                    // keep buffering
                    console.log(('have not received end of HTTP headers yet...'));
                    read();
                    return;
                }

                const firstLine = buffered.toString(
                    'ascii',
                    0,
                    buffered.indexOf('\r\n')
                );
                const statusCode = +firstLine.split(' ')[1];
                console.log(('got proxy server response: %o', firstLine));
                resolve({
                    statusCode,
                    buffered
                });
            }

            socket.on('error', onerror);
            socket.on('close', onclose);
            socket.on('end', onend);

            read();
        });
    }

    forwardRequest(socket) {
        const reqOpts = this.trgParsed;
        reqOpts.method = this.srcRequest.method;
        reqOpts.headers = {};
        socket && (reqOpts.createConnection = () => socket);

        // TODO:
        //  - We should probably use a raw HTTP message via socket instead of http.request(),
        //    since Node transforms the headers to lower case and thus makes it easy to detect the proxy
        //  - The "Connection" header might define additional hop-by-hop headers that should be removed,
        //    see https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Connection
        //  - We should also add "Via" and "X-Forwarded-For" headers
        //  - Or, alternatively, we should make this proxy fully transparent

        let hostHeaderFound = false;

        for (let i = 0; i < this.srcRequest.rawHeaders.length; i += 2) {
            const headerName = this.srcRequest.rawHeaders[i];
            const headerValue = this.srcRequest.rawHeaders[i + 1];

            if (/^connection$/i.test(headerName) && /^keep-alive$/i.test(headerValue)) {
                // Keep the "Connection: keep-alive" header, to reduce the chance that the server
                // will detect we're not a browser and also to improve performance
            } else if (isHopByHopHeader(headerName)) {
                continue;
            } else if (isInvalidHeader(headerName, headerValue)) {
                continue;
            } else if (/^host$/i.test(headerName)) {
                // If Host header was used multiple times, only consider the first one.
                // This is to prevent "TypeError: hostHeader.startsWith is not a function at calculateServerName (_http_agent.js:240:20)"
                if (hostHeaderFound) continue;
                hostHeaderFound = true;
            }

            /*
            if (!hasXForwardedFor && 'x-forwarded-for' === keyLower) {
                // append to existing "X-Forwarded-For" header
                // http://en.wikipedia.org/wiki/X-Forwarded-For
                hasXForwardedFor = true;
                value += ', ' + socket.remoteAddress;
                debug.proxyRequest('appending to existing "%s" header: "%s"', key, value);
            }

            if (!hasVia && 'via' === keyLower) {
                // append to existing "Via" header
                hasVia = true;
                value += ', ' + via;
                debug.proxyRequest('appending to existing "%s" header: "%s"', key, value);
            }
            */

            addHeader(reqOpts.headers, headerName, headerValue);
        }

        /*
        // add "X-Forwarded-For" header if it's still not here by now
        // http://en.wikipedia.org/wiki/X-Forwarded-For
        if (!hasXForwardedFor) {
            headers['X-Forwarded-For'] = socket.remoteAddress;
            debug.proxyRequest('adding new "X-Forwarded-For" header: "%s"', headers['X-Forwarded-For']);
        }

        // add "Via" header if still not set by now
        if (!hasVia) {
            headers.Via = via;
            debug.proxyRequest('adding new "Via" header: "%s"', headers.Via);
        }

        // custom `http.Agent` support, set `server.agent`
        var agent = server.agent;
        if (null != agent) {
            debug.proxyRequest('setting custom `http.Agent` option for proxy request: %s', agent);
            parsed.agent = agent;
            agent = null;
        }
         */

        // If desired, send the request via proxy
        if (this.upstreamProxyUrlParsed) {
            reqOpts.host = this.upstreamProxyUrlParsed.hostname;
            reqOpts.hostname = reqOpts.host;
            reqOpts.port = this.upstreamProxyUrlParsed.port;

            // HTTP requests to proxy contain the full URL in path, for example:
            // "GET http://www.example.com HTTP/1.1\r\n"
            // So we need to replicate it here
            reqOpts.path = this.srcRequest.url;

            maybeAddProxyAuthorizationHeader(this.upstreamProxyUrlParsed, reqOpts.headers);

            this.log(`Connecting to upstream proxy ${reqOpts.host}:${reqOpts.port}`);
        } else {
            this.log(`Connecting to target ${reqOpts.host}`);
        }

        // console.dir(requestOptions);

        this.trgRequest = http.request(reqOpts);
        this.trgRequest.on('socket', this.onTrgSocket);
        this.trgRequest.on('response', this.onTrgResponse);
        this.trgRequest.on('error', this.onTrgError);

        // this.srcRequest.pipe(tee('to trg')).pipe(this.trgRequest);
        this.srcRequest.pipe(this.trgRequest);
    }

    onTrgResponse(response) {
        if (this.isClosed) return;
        this.log(`Received response from target (${response.statusCode})`);

        if (this.checkUpstreamProxy407(response)) return;

        // Prepare response headers
        const headers = {};
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
            const name = response.rawHeaders[i];
            const value = response.rawHeaders[i + 1];

            if (isHopByHopHeader(name)) continue;
            if (isInvalidHeader(name, value)) continue;

            addHeader(headers, name, value);
        }

        // Ensure status code is in the range accepted by Node, otherwise proxy will crash with
        // "RangeError: Invalid status code: 0" (see writeHead in Node's _http_server.js)
        // Fixes https://github.com/apify/proxy-chain/issues/35
        if (response.statusCode < 100 || response.statusCode > 999) {
            this.fail(new RequestError(`Target server responded with an invalid HTTP status code (${response.statusCode})`, 500));
            return;
        }

        this.srcGotResponse = true;

        // Note that sockets could be closed anytime, causing this.close() to be called too in above statements
        // See https://github.com/apify/proxy-chain/issues/64
        if (this.isClosed) return;

        this.srcResponse.writeHead(response.statusCode, headers);
        response.pipe(this.srcResponse);
    }

    onTrgError(err) {
        if (this.isClosed) return;
        this.log(`Target socket failed: ${err.stack || err}`);
        this.fail(err);
    }
}
