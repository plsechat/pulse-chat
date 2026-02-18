import chalk from 'chalk';
import http from 'http';
import z from 'zod';
import { config } from '../config';
import { getWsInfo } from '../helpers/get-ws-info';
import { logger } from '../logger';
import {
  federationAcceptHandler,
  federationDmRelayHandler,
  federationFriendAcceptHandler,
  federationFriendRemoveHandler,
  federationFriendRequestHandler,
  federationInfoHandler,
  federationReportUserHandler,
  federationRequestHandler,
  federationServersHandler,
  federationUserInfoHandler
} from './federation';
import { healthRouteHandler } from './healthz';
import { infoRouteHandler } from './info';
import { interfaceRouteHandler } from './interface';
import { loginRouteHandler } from './login';
import { provisionRouteHandler } from './provision-user';
import { registerRouteHandler } from './register';
import { publicRouteHandler } from './public';
import { uploadFileRouteHandler } from './upload';
import { authRateLimit, federationRateLimit, checkRateLimit } from './rate-limit';
import { HttpValidationError } from './utils';
import { webhookRouteHandler } from './webhook';
import { isAllowedOrigin } from './cors';

// this http server implementation is temporary and will be moved to bun server later when things are more stable

const createHttpServer = async (port: number = config.server.port) => {
  return new Promise<http.Server>((resolve) => {
    const server = http.createServer(
      async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const origin = req.headers.origin;
        if (origin) {
          const allowed = await isAllowedOrigin(origin, req.headers.host);
          if (allowed) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
          }
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-token, x-file-name, x-file-type, x-federation-token, content-length');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; media-src 'self' blob:; connect-src 'self' https: wss: ws:; font-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://open.spotify.com https://w.soundcloud.com https://platform.twitter.com https://syndication.twitter.com https://www.reddit.com https://embed.reddit.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");

        const info = getWsInfo(undefined, req);

        logger.debug(
          `${chalk.dim('[HTTP]')} %s - %s - [%s]`,
          req.method,
          req.url,
          info?.ip
        );

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        try {
          if (req.method === 'GET' && req.url === '/healthz') {
            return await healthRouteHandler(req, res);
          }

          if (req.method === 'GET' && req.url === '/info') {
            return await infoRouteHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/upload') {
            return await uploadFileRouteHandler(req, res);
          }

          // Federation HTTP API
          if (req.method === 'GET' && req.url === '/federation/info') {
            return await federationInfoHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/federation/request') {
            if (!checkRateLimit(req, res, federationRateLimit)) return;
            return await federationRequestHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/federation/accept') {
            if (!checkRateLimit(req, res, federationRateLimit)) return;
            return await federationAcceptHandler(req, res);
          }

          if (req.method === 'GET' && req.url?.startsWith('/federation/servers')) {
            return await federationServersHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/federation/user-info') {
            if (!checkRateLimit(req, res, federationRateLimit)) return;
            return await federationUserInfoHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/federation/friend-request') {
            if (!checkRateLimit(req, res, federationRateLimit)) return;
            return await federationFriendRequestHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/federation/friend-accept') {
            if (!checkRateLimit(req, res, federationRateLimit)) return;
            return await federationFriendAcceptHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/federation/friend-remove') {
            if (!checkRateLimit(req, res, federationRateLimit)) return;
            return await federationFriendRemoveHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/federation/dm-relay') {
            if (!checkRateLimit(req, res, federationRateLimit)) return;
            return await federationDmRelayHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/federation/report-user') {
            if (!checkRateLimit(req, res, federationRateLimit)) return;
            return await federationReportUserHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/login') {
            if (!checkRateLimit(req, res, authRateLimit)) return;
            return await loginRouteHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/register') {
            if (!checkRateLimit(req, res, authRateLimit)) return;
            return await registerRouteHandler(req, res);
          }

          if (req.method === 'POST' && req.url === '/auth/provision') {
            if (!checkRateLimit(req, res, authRateLimit)) return;
            return await provisionRouteHandler(req, res);
          }

          if (
            req.method === 'POST' &&
            req.url?.match(/^\/webhooks\/(\d+)\/(.+)$/)
          ) {
            const match = req.url.match(/^\/webhooks\/(\d+)\/(.+)$/);
            if (match) {
              return await webhookRouteHandler(
                req,
                res,
                parseInt(match[1]!),
                match[2]!
              );
            }
          }

          if (req.method === 'GET' && req.url?.startsWith('/public')) {
            return await publicRouteHandler(req, res);
          }

          if (req.method === 'GET' && req.url?.startsWith('/')) {
            return await interfaceRouteHandler(req, res);
          }
        } catch (error) {
          const errorsMap: Record<string, string> = {};

          if (error instanceof z.ZodError) {
            for (const issue of error.issues) {
              const field = issue.path[0];

              if (typeof field === 'string') {
                errorsMap[field] = issue.message;
              }
            }

            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ errors: errorsMap }));
            return;
          } else if (error instanceof HttpValidationError) {
            errorsMap[error.field] = error.message;

            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ errors: errorsMap }));
            return;
          }

          logger.error('HTTP route error:', error);

          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    );

    server.on('listening', () => {
      logger.debug('HTTP server is listening on port %d', port);
      resolve(server);
    });

    server.on('close', () => {
      logger.debug('HTTP server closed');
      process.exit(0);
    });

    server.listen(port);
  });
};

export { createHttpServer };
