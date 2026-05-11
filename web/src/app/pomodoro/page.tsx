import type { Metadata } from 'next';
import { PomodoroView } from './pomodoro-view';

export const metadata: Metadata = { title: 'Pomodoro' };

export default function PomodoroPage() {
  return <PomodoroView />;
}
