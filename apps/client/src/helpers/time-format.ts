import { getTimeFormat } from '@/hooks/use-appearance-settings';

const is24h = () => getTimeFormat() === '24h';

/** Time only: "3:45 PM" / "15:45" */
export const timeOnly = () => (is24h() ? 'HH:mm' : 'h:mm a');

/** Date + time: "01/15/2025 3:45 PM" / "01/15/2025 15:45" */
export const dateTime = () => (is24h() ? 'MM/dd/yyyy HH:mm' : 'MM/dd/yyyy h:mm a');

/** Long date + time: "Jan 15, 2025 3:45 PM" / "Jan 15, 2025 15:45" */
export const longDateTime = () => (is24h() ? 'MMM d, yyyy HH:mm' : 'MMM d, yyyy h:mm a');

/** Full date + time (tooltips): "January 15, 2025, 3:45 PM" / "January 15, 2025 15:45" */
export const fullDateTime = () => (is24h() ? 'PPP HH:mm' : 'PPpp');

/** Date + time (tables): "January 15, 2025 3:45 PM" / "January 15, 2025 15:45" */
export const datePlusTime = () => (is24h() ? 'PPP HH:mm' : 'PPP p');
