import chalk from 'chalk';
import http from 'http';
import z from 'zod';
import { config } from '../config';
import { getWsInfo } from '../helpers/get-ws-info';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import { logger } from '../logger';
import { newRequestId, withLogContext } from '../utils/log-context';
import { isAllowedOrigin } from './cors';
import {
  federationAcceptHandler,
  federationDmRelayHandler,
  federationFriendAcceptHandler,
  federationFriendRemoveHandler,
  federationFriendRequestHandler,
  federationGetPreKeyBundleHandler,
  federationInfoHandler,
  federationReportUserHandler,
  federationRequestHandler,
  federationServersHandler,
  federationUserInfoHandler
} from './federation';
import { federationChannelSenderKeyNotifyHandler } from './federation-channel-sender-key';
import { federationDmChannelStateUpdateHandler } from './federation-dm-channel-state';
import {
  federationDmGroupAddMemberHandler,
  federationDmGroupCreateHandler,
  federationDmGroupRemoveMemberHandler,
  federationDmSenderKeyHandler,
  federationIdentityRotationHandler
} from './federation-dm-group';
import { federationUserInfoUpdateHandler } from './federation-user-info-update';
import { healthRouteHandler } from './healthz';
import { JsonBodyTooLargeError } from './helpers';
import { infoRouteHandler } from './info';
import { interfaceRouteHandler } from './interface';
import { loginRouteHandler } from './login';
import { provisionRouteHandler } from './provision-user';
import { publicRouteHandler } from './public';
import {
  authRateLimit,
  checkRateLimit,
  federationRateLimit,
  uploadRateLimit
} from './rate-limit';
import { registerRouteHandler } from './register';
import { uploadFileRouteHandler } from './upload';
import { HttpValidationError } from './utils';
import { webhookRouteHandler } from './webhook';

// this http server implementation is temporary and will be moved to bun server later when things are more stable

const createHttpServer = async (port: number = config.server.port) => {
  return new Promise<http.Server>((resolve) => {
    const server = http.createServer(
      async (req: http.IncomingMessage, res: http.ServerResponse) => {
        // Seed an async-local correlation context for this request. If the
        // caller is a peer instance, carry over their X-Pulse-Request-Id
        // so both sides' debug lines share an id; otherwise mint a fresh
        // one. All downstream `logger.*` calls inside this stack pick the
        // id up via `getLogContext()` and stamp it onto the JSON payload.
        const inboundId = req.headers['x-pulse-request-id'];
        const requestId =
          typeof inboundId === 'string' &&
          inboundId.length > 0 &&
          inboundId.length < 200
            ? inboundId
            : newRequestId();
        await withLogContext({ requestId, route: req.url }, () =>
          handleHttpRequest(req, res)
        );
      }
    );

    async function handleHttpRequest(
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) {
      const origin = req.headers.origin;
      if (origin) {
        const allowed = await isAllowedOrigin(origin, req.headers.host);
        if (allowed) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-token, x-file-name, x-file-type, x-federation-token, content-length'
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; media-src 'self' https: blob:; connect-src 'self' https: wss: ws:; font-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://open.spotify.com https://w.soundcloud.com https://platform.twitter.com https://syndication.twitter.com https://www.reddit.com https://embed.reddit.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      );

      const info = getWsInfo(undefined, req);

      logger.debug(
        `${chalk.dim('[HTTP]')} %s - %s - [%s]`,
        req.method,
        sanitizeForLog(req.url),
        sanitizeForLog(info?.ip)
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
          if (!checkRateLimit(req, res, uploadRateLimit)) return;
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

        if (
          req.method === 'GET' &&
          req.url?.startsWith('/federation/servers')
        ) {
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

        if (
          req.method === 'POST' &&
          req.url === '/federation/get-prekey-bundle'
        ) {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationGetPreKeyBundleHandler(req, res);
        }

        if (
          req.method === 'POST' &&
          req.url === '/federation/dm-group-create'
        ) {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationDmGroupCreateHandler(req, res);
        }

        if (
          req.method === 'POST' &&
          req.url === '/federation/dm-group-add-member'
        ) {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationDmGroupAddMemberHandler(req, res);
        }

        if (
          req.method === 'POST' &&
          req.url === '/federation/dm-group-remove-member'
        ) {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationDmGroupRemoveMemberHandler(req, res);
        }

        if (req.method === 'POST' && req.url === '/federation/dm-sender-key') {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationDmSenderKeyHandler(req, res);
        }

        if (
          req.method === 'POST' &&
          req.url === '/federation/identity-rotation-broadcast'
        ) {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationIdentityRotationHandler(req, res);
        }

        if (
          req.method === 'POST' &&
          req.url === '/federation/dm-channel-state-update'
        ) {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationDmChannelStateUpdateHandler(req, res);
        }

        if (
          req.method === 'POST' &&
          req.url === '/federation/user-info-update'
        ) {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationUserInfoUpdateHandler(req, res);
        }

        if (
          req.method === 'POST' &&
          req.url === '/federation/channel-sender-key-notify'
        ) {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationChannelSenderKeyNotifyHandler(req, res);
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
        } else if (error instanceof JsonBodyTooLargeError) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
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
