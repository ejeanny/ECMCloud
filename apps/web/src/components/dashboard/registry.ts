import type { WidgetId, WidgetMeta } from '@/lib/dashboard';
import { ActivityWidget } from './widgets/activity';
import { ServicesWidget } from './widgets/services';
import {
  CabinetsWidget,
  CheckoutsWidget,
  FavoritesWidget,
  NotificationsWidget,
  RecentWidget,
  TasksWidget,
} from './widgets/lists';

/** Everything the dashboard knows how to draw, by id. */
export const WIDGETS: Record<WidgetId, WidgetMeta> = {
  tasks: {
    id: 'tasks',
    title: 'My tasks',
    description: 'Workflow steps waiting on a decision from you.',
    href: '/inbox',
    defaultSize: 'sm',
    Body: TasksWidget,
  },
  checkouts: {
    id: 'checkouts',
    title: 'My check-outs',
    description: 'Documents you hold the lock on.',
    href: '/checkouts',
    defaultSize: 'sm',
    Body: CheckoutsWidget,
  },
  notifications: {
    id: 'notifications',
    title: 'Notifications',
    description: 'What the application and its workflows have told you.',
    href: '/notifications',
    defaultSize: 'sm',
    Body: NotificationsWidget,
  },
  recent: {
    id: 'recent',
    title: 'Recent documents',
    description: 'The documents you opened last.',
    defaultSize: 'md',
    Body: RecentWidget,
  },
  cabinets: {
    id: 'cabinets',
    title: 'Cabinets',
    description: 'The cabinets you can reach, pinned ones first.',
    href: '/cabinets',
    defaultSize: 'md',
    Body: CabinetsWidget,
  },
  favorites: {
    id: 'favorites',
    title: 'Favourites',
    description: 'Documents you have starred.',
    href: '/favorites',
    defaultSize: 'sm',
    Body: FavoritesWidget,
  },
  activity: {
    id: 'activity',
    title: 'Activity',
    description: 'Audit events per day across every cabinet.',
    href: '/admin/audit',
    requires: 'View_Audit_Log',
    defaultSize: 'lg',
    Body: ActivityWidget,
  },
  services: {
    id: 'services',
    title: 'Services',
    description: 'Queue depth per job kind, with failures called out.',
    href: '/admin/jobs',
    requires: 'Services_Logs',
    defaultSize: 'sm',
    Body: ServicesWidget,
  },
};

export const WIDGET_IDS = Object.keys(WIDGETS) as WidgetId[];
