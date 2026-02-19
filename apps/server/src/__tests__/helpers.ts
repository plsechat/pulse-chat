import { UploadHeaders } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { appRouter } from '../routers';
import { users } from '../db/schema';
import { supabaseAdmin } from '../utils/supabase';
import { createMockContext } from './context';
import { getTestDb } from './mock-db';
import { testsBaseUrl } from './setup';

const getMockedToken = async (userId: number) => {
  const tdb = getTestDb();

  // Get the user's supabaseId from the test database
  const [user] = await tdb
    .select({ supabaseId: users.supabaseId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new Error(`Test user with id ${userId} not found`);
  }

  // Generate a Supabase token for this user
  const { data, error } =
    await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: `test-${user.supabaseId}@pulse.local`
    });

  if (error || !data) {
    throw new Error(`Failed to generate test token: ${error?.message}`);
  }

  // Sign in to get a real access token
  // For tests, we use the supabaseId directly as a mock token
  // The test context mock will handle verification
  return user.supabaseId;
};

const getCaller = async (userId: number) => {
  const mockedToken = await getMockedToken(userId);

  const ctx = await createMockContext({
    customToken: mockedToken
  });

  const caller = appRouter.createCaller(ctx);

  return { caller, mockedToken, ctx };
};

// this will basically simulate a specific user connecting to the server
const initTest = async (userId: number = 1) => {
  const { caller, mockedToken, ctx } = await getCaller(userId);
  const { handshakeHash } = await caller.others.handshake();

  const initialData = await caller.others.joinServer({
    handshakeHash: handshakeHash
  });

  // Ensure activeServerId is set on the context object.
  // tRPC createCaller may not persist context mutations across procedure calls.
  ctx.activeServerId = initialData.serverDbId;

  return { caller, mockedToken, initialData, ctx };
};

const login = async (email: string, password: string, invite?: string) =>
  fetch(`${testsBaseUrl}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      password,
      invite
    })
  });

const uploadFile = async (file: File, token: string) =>
  fetch(`${testsBaseUrl}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      [UploadHeaders.TYPE]: file.type,
      [UploadHeaders.CONTENT_LENGTH]: file.size.toString(),
      [UploadHeaders.ORIGINAL_NAME]: file.name,
      [UploadHeaders.TOKEN]: token
    },
    body: file
  });

export { getCaller, getMockedToken, initTest, login, uploadFile };
