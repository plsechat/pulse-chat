import { t } from '../../utils/trpc';
import { cancelEventRoute } from './cancel';
import { createEventRoute } from './create';
import { declineRoute } from './decline';
import {
  onEventCreateRoute,
  onEventDeleteRoute,
  onEventReminderRoute,
  onEventSignupsUpdateRoute,
  onEventUpdateRoute
} from './events';
import { getEventRoute } from './get';
import { getCalendarUrlRoute } from './get-calendar-url';
import { listEventsRoute } from './list';
import { setSignupStatusRoute } from './set-signup-status';
import { signupRoute } from './signup';
import { createTemplateRoute } from './templates-create';
import { deleteTemplateRoute } from './templates-delete';
import { listTemplatesRoute } from './templates-list';
import { updateTemplateRoute } from './templates-update';
import { updateEventRoute } from './update';
import { withdrawRoute } from './withdraw';

export const eventsRouter = t.router({
  create: createEventRoute,
  update: updateEventRoute,
  cancel: cancelEventRoute,
  list: listEventsRoute,
  get: getEventRoute,
  signup: signupRoute,
  decline: declineRoute,
  withdraw: withdrawRoute,
  setSignupStatus: setSignupStatusRoute,
  getCalendarUrl: getCalendarUrlRoute,
  templates: t.router({
    list: listTemplatesRoute,
    create: createTemplateRoute,
    update: updateTemplateRoute,
    delete: deleteTemplateRoute
  }),
  onEventCreate: onEventCreateRoute,
  onEventUpdate: onEventUpdateRoute,
  onEventDelete: onEventDeleteRoute,
  onEventSignupsUpdate: onEventSignupsUpdateRoute,
  onEventReminder: onEventReminderRoute
});
