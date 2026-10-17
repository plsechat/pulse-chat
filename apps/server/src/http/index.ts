import { UploadHeaders } from '@pulse/shared';
import chalk from 'chalk';
import http from 'http';
import z from 'zod';
import { config } from '../config';
import {
  getClientIp,
  getWsInfo,
  resolvePublicOrigin
} from '../helpers/get-ws-info';
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
  federationKeyRotationHandler,
  federationReportUserHandler,
  federationRequestHandler,
  federationServersHandler,
  federationUnpeerHandler,
  federationUserInfoHandler
} from './federation';
import { federationChannelSenderKeyNotifyHandler } from './federation-channel-sender-key';
import { federationDirectoryHandler } from './federation-directory';
import { federationDmChannelStateUpdateHandler } from './federation-dm-channel-state';
import {
  federationDmGroupAddMemberHandler,
  federationDmGroupCreateHandler,
  federationDmGroupRemoveMemberHandler,
  federationDmSenderKeyHandler,
  federationIdentityRotationHandler
} from './federation-dm-group';
import {
  federationAnnouncementFollowHandler,
  federationAnnouncementHandler
} from './federation-announcement';
import { federationMemberRemovedHandler } from './federation-member-removed';
import { federationSharesServerHandler } from './federation-shares-server';
import { federationUserInfoUpdateHandler } from './federation-user-info-update';
import { eventsIcsRouteHandler } from './events-ics';
import { healthRouteHandler } from './healthz';
import { JsonBodyTooLargeError } from './helpers';
import { infoRouteHandler } from './info';
import { interfaceRouteHandler } from './interface';
import { loginRouteHandler } from './login';
import { logoutRouteHandler } from './logout';
import { provisionRouteHandler } from './provision-user';
import { refreshRouteHandler } from './refresh';
import { oidcCallbackRouteHandler, oidcStartRouteHandler } from './oidc';
import { publicRouteHandler } from './public';
import { checkRateLimit } from './rate-limit';
import {
  authRateLimit,
  federationRateLimit,
  federationReadRateLimit,
  pluginHttpIdRateLimit,
  pluginHttpRateLimit,
  publicRateLimit,
  uploadRateLimit,
  webhookIdRateLimit,
  webhookRateLimit
} from './rate-limit-core';
import { parsePluginHttpUrl } from '../plugins/http';
import { pluginManager } from '../plugins';
import { registerRouteHandler } from './register';
import { uploadFileRouteHandler } from './upload';
import { HttpValidationError } from './utils';
import { webhookRouteHandler } from './webhook';

// this http server implementation is temporary and will be moved to bun server later when things are more stable

// Every header the browser client sets on a cross-origin call (federated
// uploads carry the full UploadHeaders set, incl. x-file-encrypted) plus
// the bearer/federation/correlation headers. Built from the shared enum
// so a new upload header cannot silently fail the preflight again.
const CORS_ALLOW_HEADERS = Array.from(
  new Set([
    'content-type',
    'authorization',
    'x-federation-token',
    'x-pulse-request-id',
    ...Object.values(UploadHeaders)
  ])
).join(', ');

// 'unsafe-eval' is not needed: the only eval in the built client is
// protobufjs' try/catch-guarded `eval("require")` probe, which fails
// closed. Fonts are self-hosted, so font-src stays 'self'.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; media-src 'self' https: blob:; connect-src 'self' https: wss: ws: blob:; font-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://open.spotify.com https://w.soundcloud.com https://platform.twitter.com https://syndication.twitter.com https://www.reddit.com https://embed.reddit.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const PERMISSIONS_POLICY =
  'camera=(self), microphone=(self), display-capture=(self), geolocation=()';

// One year, subdomains included. Only sent when the request is known to
// have arrived over TLS (PUBLIC_URL / trusted x-forwarded-proto / a TLS
// socket) — on a plain-http deployment it would pin browsers to an
// origin that does not exist.
const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

// Webhook ids are int4 primary keys; anything wider is a 404, not a
// Postgres out-of-range 500. The token capture stops at `?`/`#` so a
// query string is never swallowed into the token.
const WEBHOOK_PATH = /^\/webhooks\/(\d{1,10})\/([^/?#]+)(?:[?#].*)?$/;
const MAX_WEBHOOK_ID = 2_147_483_647;

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
      const publicOrigin = resolvePublicOrigin(req);

      // The allow-origin value depends on the Origin header, so caches
      // must key on it. Credentials are never allowed: auth is a bearer
      // token / x-token header, and the only cookie (OIDC state) is
      // scoped to its own path.
      res.setHeader('Vary', 'Origin');
      const origin = req.headers.origin;
      if (origin) {
        const allowed = await isAllowedOrigin(origin, publicOrigin.host);
        if (allowed) {
          res.setHeader('Access-Control-Allow-Origin', origin);
        }
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
      res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
      if (publicOrigin.proto === 'https') {
        res.setHeader('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
      }

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
          if (!checkRateLimit(req, res, federationReadRateLimit)) return;
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

        // Signed like every other peer route; the per-IP brake stays as
        // the pre-auth flood guard (the per-peer budget applies after
        // the signature verifies).
        if (req.method === 'POST' && req.url === '/federation/servers') {
          if (!checkRateLimit(req, res, federationReadRateLimit)) return;
          return await federationServersHandler(req, res);
        }

        // Directory listing for a peer's Directory tab — same read
        // bucket and signing discipline as /federation/servers.
        if (req.method === 'POST' && req.url === '/federation/directory') {
          if (!checkRateLimit(req, res, federationReadRateLimit)) return;
          return await federationDirectoryHandler(req, res);
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

        if (req.method === 'POST' && req.url === '/federation/shares-server') {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationSharesServerHandler(req, res);
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
          req.url === '/federation/member-removed'
        ) {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationMemberRemovedHandler(req, res);
        }

        if (req.method === 'POST' && req.url === '/federation/announcement') {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationAnnouncementHandler(req, res);
        }

        if (
          req.method === 'POST' &&
          req.url === '/federation/announcement-follow'
        ) {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationAnnouncementFollowHandler(req, res);
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

        if (req.method === 'POST' && req.url === '/federation/unpeer') {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationUnpeerHandler(req, res);
        }

        if (req.method === 'POST' && req.url === '/federation/key-rotation') {
          if (!checkRateLimit(req, res, federationRateLimit)) return;
          return await federationKeyRotationHandler(req, res);
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

        if (req.method === 'POST' && req.url === '/auth/refresh') {
          if (!checkRateLimit(req, res, authRateLimit)) return;
          return await refreshRouteHandler(req, res);
        }

        if (req.method === 'POST' && req.url === '/auth/logout') {
          if (!checkRateLimit(req, res, authRateLimit)) return;
          return await logoutRouteHandler(req, res);
        }

        if (req.method === 'GET' && req.url?.startsWith('/auth/oidc/start')) {
          if (!checkRateLimit(req, res, authRateLimit)) return;
          return await oidcStartRouteHandler(req, res);
        }

        if (req.method === 'GET' && req.url?.startsWith('/auth/oidc/callback')) {
          if (!checkRateLimit(req, res, authRateLimit)) return;
          return await oidcCallbackRouteHandler(req, res);
        }

        if (req.method === 'POST' && req.url?.startsWith('/webhooks/')) {
          const match = req.url.match(WEBHOOK_PATH);
          const webhookId = match ? Number.parseInt(match[1]!, 10) : NaN;

          if (!match || webhookId > MAX_WEBHOOK_ID) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Webhook not found' }));
            return;
          }

          // Two budgets: per source address for this webhook (token
          // guessing / floods from one host) and per webhook id across
          // every source (what one integration may inject). Neither key
          // includes the token, so a wrong guess shares the bucket.
          const ip = getClientIp(req);
          if (
            !checkRateLimit(
              req,
              res,
              webhookRateLimit,
              `${ip}:/webhooks/${webhookId}`
            )
          ) {
            return;
          }
          if (
            !checkRateLimit(
              req,
              res,
              webhookIdRateLimit,
              `webhook-id:${webhookId}`
            )
          ) {
            return;
          }

          return await webhookRouteHandler(req, res, webhookId, match[2]!);
        }

        // Calendar feed: credential-in-URL (see events-ics.ts), so it
        // shares the public-file brake per source address.
        if (req.method === 'GET' && req.url?.startsWith('/events/')) {
          if (
            !checkRateLimit(
              req,
              res,
              publicRateLimit,
              `${getClientIp(req)}:/events`
            )
          ) {
            return;
          }
          return await eventsIcsRouteHandler(req, res);
        }

        // Plugin HTTP ingress (`ctx.http.register`). Same two budgets as
        // webhooks: per source address for this plugin, and per plugin
        // across every source. The secret check is inside the handler.
        if (
          (req.method === 'POST' || req.method === 'GET') &&
          req.url?.startsWith('/plugins/')
        ) {
          const parsed = parsePluginHttpUrl(req.url);

          if (!parsed) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
          }

          const ip = getClientIp(req);
          if (
            !checkRateLimit(
              req,
              res,
              pluginHttpRateLimit,
              `${ip}:/plugins/${parsed.pluginId}`
            )
          ) {
            return;
          }
          if (
            !checkRateLimit(
              req,
              res,
              pluginHttpIdRateLimit,
              `plugin-id:${parsed.pluginId}`
            )
          ) {
            return;
          }

          return await pluginManager.handleHttpRequest(req, res, parsed);
        }

        if (req.method === 'GET' && req.url?.startsWith('/public')) {
          // One bucket per source for the whole prefix: the file name
          // varies per request, so an `ip:pathname` key would never
          // accumulate.
          if (
            !checkRateLimit(
              req,
              res,
              publicRateLimit,
              `${getClientIp(req)}:/public`
            )
          ) {
            return;
          }
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
    });

    server.listen(port);
  });
};

export { createHttpServer };
