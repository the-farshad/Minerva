'use client';

import {
  PlaySquare, FileText, CheckSquare, Folder, Zap, BookOpen, Inbox, Bookmark,
  Hash, Network,
} from 'lucide-react';

/** Maps the preset's `icon` string (or its `slug` / `preset` as a
 * fallback) to a Lucide icon. Returns null when nothing matches so
 * the caller can omit the icon entirely. */
export function SectionIcon({
  hint, className = 'h-4 w-4',
}: {
  hint?: string | null;
  className?: string;
}) {
  const key = (hint || '').toLowerCase();
  switch (key) {
    case 'youtube':       return <PlaySquare className={className} />;
    case 'papers':
    case 'paper':
    case 'file-text':     return <FileText className={className} />;
    case 'tasks':
    case 'check-square':  return <CheckSquare className={className} />;
    case 'projects':
    case 'folder':        return <Folder className={className} />;
    case 'habits':
    case 'zap':           return <Zap className={className} />;
    case 'notes':
    case 'book-open':     return <BookOpen className={className} />;
    case 'inbox':         return <Inbox className={className} />;
    case 'bookmarks':
    case 'bookmark':      return <Bookmark className={className} />;
    case 'graph':
    case 'network':       return <Network className={className} />;
    default:              return <Hash className={className} />;
  }
}
