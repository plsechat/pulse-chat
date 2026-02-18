import crypto from 'crypto';

function base64url(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

function generateJwt(payload: object, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

const jwtSecret = crypto.randomBytes(32).toString('base64');
const now = Math.floor(Date.now() / 1000);
const exp = now + 10 * 365 * 24 * 60 * 60; // 10 years

const anonKey = generateJwt(
  { role: 'anon', iss: 'supabase', iat: now, exp },
  jwtSecret
);

const serviceRoleKey = generateJwt(
  { role: 'service_role', iss: 'supabase', iat: now, exp },
  jwtSecret
);

console.log(`JWT_SECRET=${jwtSecret}`);
console.log(`SUPABASE_ANON_KEY=${anonKey}`);
console.log(`SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`);
