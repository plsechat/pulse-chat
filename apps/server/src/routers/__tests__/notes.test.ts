import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createTestUser } from '../../__tests__/fixtures';
import { firstSubscriptionEvent, initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { userNotes } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';

/**
 * notes router: private per-author notes about another user. The
 * client (user-popover) renders `getAll` as a list and adds/deletes
 * entries, so the server contract is append-only, newest first — not
 * an upsert of one note per target. Privacy: an author's notes are
 * invisible to and undeletable by anyone else.
 */

type PublishCall = [number | number[], string, Record<string, unknown>];

const noteUpdates = (spy: { mock: { calls: unknown[][] } }) =>
  (spy.mock.calls as PublishCall[]).filter(
    ([, t]) => t === ServerEvents.USER_NOTE_UPDATE
  );

const notesOn = async (targetUserId: number) =>
  getTestDb()
    .select()
    .from(userNotes)
    .where(eq(userNotes.targetUserId, targetUserId));

afterEach(() => {
  mock.restore();
});

describe('notes.add / getAll / delete', () => {
  test('add returns the row and getAll lists it for the author', async () => {
    const { caller } = await initTest(1);

    const note = await caller.notes.add({ targetUserId: 2, content: 'met at the meetup' });
    expect(note).toMatchObject({ content: 'met at the meetup' });
    expect(note!.id).toBeGreaterThan(0);
    expect(typeof note!.createdAt).toBe('number');

    const { notes } = await caller.notes.getAll({ targetUserId: 2 });
    expect(notes).toEqual([
      { id: note!.id, content: 'met at the meetup', createdAt: note!.createdAt }
    ]);
    expect((await caller.notes.getAll({ targetUserId: 3 })).notes).toEqual([]);
  });

  test('a second note on the same target is appended and listed newest first', async () => {
    const { caller } = await initTest(1);
    const tdb = getTestDb();

    const first = await caller.notes.add({ targetUserId: 2, content: 'first' });
    // Force a strictly later timestamp so the ordering is deterministic.
    await tdb
      .update(userNotes)
      .set({ createdAt: first!.createdAt - 1_000 })
      .where(eq(userNotes.id, first!.id));
    const second = await caller.notes.add({ targetUserId: 2, content: 'second' });

    const { notes } = await caller.notes.getAll({ targetUserId: 2 });
    expect(notes.map((n) => n.id)).toEqual([second!.id, first!.id]);
    expect(await notesOn(2)).toHaveLength(2);
  });

  test('delete removes the author\'s note and stays silent for an unknown id', async () => {
    const { caller } = await initTest(1);
    const note = await caller.notes.add({ targetUserId: 2, content: 'bye' });

    await caller.notes.delete({ noteId: note!.id });
    expect(await notesOn(2)).toHaveLength(0);

    const spy = spyOn(pubsub, 'publishFor');
    await expect(caller.notes.delete({ noteId: note!.id })).resolves.toBeUndefined();
    await expect(caller.notes.delete({ noteId: 999_999 })).resolves.toBeUndefined();
    expect(noteUpdates(spy)).toHaveLength(0);
  });

  test('a note may be taken on a user who shares no server', async () => {
    const { caller } = await initTest(1);
    const stranger = await createTestUser({ name: 'stranger' });

    const note = await caller.notes.add({ targetUserId: stranger, content: 'seen in federation' });
    expect((await caller.notes.getAll({ targetUserId: stranger })).notes).toHaveLength(1);
    expect(note!.content).toBe('seen in federation');
  });

  test('a note on an unknown user id is refused and writes nothing', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.notes.add({ targetUserId: 999_999, content: 'ghost' })
    ).rejects.toThrow();
    expect(await getTestDb().select().from(userNotes)).toHaveLength(0);
  });
});

describe('notes privacy', () => {
  test('user B cannot read A\'s note on C, and sees only their own', async () => {
    const { caller: callerA } = await initTest(1);
    const { caller: callerB } = await initTest(2);

    await callerA.notes.add({ targetUserId: 3, content: 'A about C' });
    const own = await callerB.notes.add({ targetUserId: 3, content: 'B about C' });

    const { notes: seenByB } = await callerB.notes.getAll({ targetUserId: 3 });
    expect(seenByB.map((n) => n.id)).toEqual([own!.id]);
    expect(seenByB[0]!.content).toBe('B about C');

    // The target cannot see notes about themselves.
    const { caller: callerC } = await initTest(3);
    expect((await callerC.notes.getAll({ targetUserId: 3 })).notes).toEqual([]);
  });

  test('user B cannot delete A\'s note: the row stays and nothing is published', async () => {
    const { caller: callerA } = await initTest(1);
    const { caller: callerB } = await initTest(2);
    const note = await callerA.notes.add({ targetUserId: 3, content: 'A about C' });

    const spy = spyOn(pubsub, 'publishFor');
    await expect(callerB.notes.delete({ noteId: note!.id })).resolves.toBeUndefined();

    expect(await notesOn(3)).toHaveLength(1);
    expect(noteUpdates(spy)).toHaveLength(0);
    // The author still can.
    await callerA.notes.delete({ noteId: note!.id });
    expect(await notesOn(3)).toHaveLength(0);
  });
});

describe('notes bounds', () => {
  test('content must be 1..2000 characters', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.notes.add({ targetUserId: 2, content: '' })
    ).rejects.toThrow();
    await expect(
      caller.notes.add({ targetUserId: 2, content: 'x'.repeat(2001) })
    ).rejects.toThrow();
    const max = await caller.notes.add({ targetUserId: 2, content: 'x'.repeat(2000) });
    expect(max!.content).toHaveLength(2000);
    expect(await notesOn(2)).toHaveLength(1);
  });

  test('ids must be numbers', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.notes.add({ targetUserId: '2' as unknown as number, content: 'x' })
    ).rejects.toThrow();
    await expect(
      caller.notes.getAll({ targetUserId: undefined as unknown as number })
    ).rejects.toThrow();
    await expect(
      caller.notes.delete({ noteId: 'abc' as unknown as number })
    ).rejects.toThrow();
  });
});

describe('notes events', () => {
  test('USER_NOTE_UPDATE is published to the author only, on add and delete', async () => {
    const { caller } = await initTest(1);

    const spy = spyOn(pubsub, 'publishFor');
    const note = await caller.notes.add({ targetUserId: 2, content: 'n' });
    await caller.notes.delete({ noteId: note!.id });

    const updates = noteUpdates(spy);
    expect(updates).toHaveLength(2);
    expect(updates[0]![0]).toBe(1);
    expect(updates[0]![2]).toEqual({ targetUserId: 2 });
    expect(updates[1]![0]).toBe(1);
    expect(updates[1]![2]).toEqual({ targetUserId: 2 });
  });

  test('onNoteUpdate yields the target on add', async () => {
    const { caller } = await initTest(1);

    const event = await firstSubscriptionEvent(
      caller,
      'notes',
      'onNoteUpdate',
      () => caller.notes.add({ targetUserId: 3, content: 'cross-tab' })
    );
    expect(event).toEqual({ targetUserId: 3 });
  });

  test('onNoteUpdate yields the target on delete', async () => {
    const { caller } = await initTest(1);
    const note = await caller.notes.add({ targetUserId: 3, content: 'gone soon' });

    const event = await firstSubscriptionEvent(
      caller,
      'notes',
      'onNoteUpdate',
      () => caller.notes.delete({ noteId: note!.id })
    );
    expect(event).toEqual({ targetUserId: 3 });
  });

  test('onNoteUpdate on another user stays silent', async () => {
    const { caller: callerA } = await initTest(1);
    const { caller: callerB } = await initTest(2);

    await expect(
      firstSubscriptionEvent(
        callerB,
        'notes',
        'onNoteUpdate',
        () => callerA.notes.add({ targetUserId: 3, content: 'private' }),
        { timeoutMs: 150 }
      )
    ).rejects.toThrow('yielded no event');
  });
});
