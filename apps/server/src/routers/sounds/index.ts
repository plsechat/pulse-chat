import { t } from '../../utils/trpc';
import { addSoundRoute } from './add-sound';
import { deleteSoundRoute } from './delete-sound';
import {
  onSoundCreateRoute,
  onSoundDeleteRoute,
  onSoundUpdateRoute
} from './events';
import { getSoundsRoute } from './get-sounds';
import { updateSoundRoute } from './update-sound';

/**
 * Soundboard management (Server Settings → Expression → Sounds). Playing
 * a clip lives on the voice router (`voice.playSound`): it is a room
 * action, resolved from the caller's voice session.
 */
export const soundsRouter = t.router({
  add: addSoundRoute,
  update: updateSoundRoute,
  delete: deleteSoundRoute,
  getAll: getSoundsRoute,
  onCreate: onSoundCreateRoute,
  onUpdate: onSoundUpdateRoute,
  onDelete: onSoundDeleteRoute
});
