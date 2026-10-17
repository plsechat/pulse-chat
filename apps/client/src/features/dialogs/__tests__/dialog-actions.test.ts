import { beforeEach, describe, expect, test } from 'bun:test';
import { Dialog } from '@/components/dialogs/dialogs';
import { createDialogController } from '@/features/dialogs/actions';
import { dialogSliceReducer } from '@/features/dialogs/slice';
import { configureStore } from '@reduxjs/toolkit';

// A private store: other suites replace the root store module
// process-wide, and the timing under test does not need it.
const makeStore = () => configureStore({ reducer: { dialog: dialogSliceReducer } });
let store = makeStore();
let controller = createDialogController((action) => store.dispatch(action));
const { openDialog, closeDialogs } = {
  openDialog: (...args: Parameters<typeof controller.openDialog>) => controller.openDialog(...args),
  closeDialogs: () => controller.closeDialogs()
};

const dialogState = () => store.getState().dialog;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('dialog close timing', () => {
  beforeEach(() => {
    store = makeStore();
    controller = createDialogController((action) => store.dispatch(action));
  });

  test('a close clears the dialog once the fade is over', async () => {
    openDialog(Dialog.CONFIRM_ACTION, { title: 'a' });
    closeDialogs();
    expect(dialogState()).toMatchObject({ openDialog: Dialog.CONFIRM_ACTION, isOpen: true, closing: true });
    await sleep(220);
    expect(dialogState()).toMatchObject({ openDialog: undefined, isOpen: false, closing: false });
  });

  test('a dialog opened during the previous close window survives that close', async () => {
    openDialog(Dialog.SCHEDULE_POST, { channelId: 1 });
    closeDialogs();
    await sleep(40);
    // The user reached a confirmation before the schedule dialog's fade ended.
    openDialog(Dialog.CONFIRM_ACTION, { title: 'Cancel scheduled message' });
    expect(dialogState()).toMatchObject({ openDialog: Dialog.CONFIRM_ACTION, isOpen: true, closing: false });
    await sleep(220);
    expect(dialogState()).toMatchObject({
      openDialog: Dialog.CONFIRM_ACTION,
      props: { title: 'Cancel scheduled message' },
      isOpen: true,
      closing: false
    });
    // Its own close still lands.
    closeDialogs();
    await sleep(220);
    expect(dialogState().openDialog).toBeUndefined();
  });

  test('a repeated close keeps the latest timer only', async () => {
    openDialog(Dialog.CONFIRM_ACTION);
    closeDialogs();
    await sleep(100);
    closeDialogs();
    await sleep(80);
    // 180 ms after the first close: the first timer was superseded, the second is pending.
    expect(dialogState()).toMatchObject({ openDialog: Dialog.CONFIRM_ACTION, closing: true });
    await sleep(120);
    expect(dialogState().openDialog).toBeUndefined();
  });
});
