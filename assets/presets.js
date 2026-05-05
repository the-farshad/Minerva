/* Minerva — section presets.
 *
 * One-click section templates. Each preset defines a tab name + icon +
 * column schema (header row + type-hint row). Picking a preset in
 * Settings creates the tab in the user's spreadsheet, seeds the schema,
 * and appends a row to _config so the section shows up in the nav.
 *
 * Presets are intentionally opinionated — meant as starting points, not
 * cages. Once a section exists, the user is free to add columns, rename
 * fields, or change types directly in Sheets.
 */
(function () {
  'use strict';

  var PRESETS = [
    {
      slug: 'reading',
      title: 'Reading list',
      icon: 'library',
      description: 'Articles, papers, podcasts, books — track what you want to read and what you actually read.',
      schema: {
        headers: ['id','title','url','kind','rating','read','tags','notes','_updated'],
        types:   ['text','text','link','select(article,paper,book,podcast,video)','rating(0..5)','check','multiselect()','markdown','datetime']
      },
      defaultSort: '_updated:desc'
    },
    {
      slug: 'journal',
      title: 'Journal',
      icon: 'book-open',
      description: 'Daily journal entries with mood + energy ratings, sorted newest-first.',
      schema: {
        headers: ['id','date','entry','mood','energy','tags','_updated'],
        types:   ['text','date','markdown','rating(0..5)','rating(0..5)','multiselect()','datetime']
      },
      defaultSort: 'date:desc'
    },
    {
      slug: 'decisions',
      title: 'Decisions',
      icon: 'scale',
      description: 'Significant decisions you\'ve made, with context, expected outcome, and a date to revisit.',
      schema: {
        headers: ['id','decision','context','made','revisit','outcome','_updated'],
        types:   ['text','text','markdown','date','date','longtext','datetime']
      },
      defaultSort: 'made:desc'
    },
    {
      slug: 'books',
      title: 'Books',
      icon: 'book',
      description: 'Books you\'re reading or have finished, with start/finish dates, category, and a rating.',
      schema: {
        headers: ['id','title','author','category','started','finished','rating','notes','_updated'],
        types:   ['text','text','text','multiselect(fiction,non-fiction,biography,history,science,philosophy,technical,reference,poetry,other)','date','date','rating(0..5)','markdown','datetime']
      }
    },
    {
      slug: 'films',
      title: 'Films',
      icon: 'film',
      description: 'Films watched with date, category, rating, and notes.',
      schema: {
        headers: ['id','title','category','watched','rating','notes','_updated'],
        types:   ['text','text','multiselect(drama,comedy,action,thriller,sci-fi,horror,documentary,animation,romance,other)','date','rating(0..5)','markdown','datetime']
      },
      defaultSort: 'watched:desc'
    },
    {
      slug: 'workouts',
      title: 'Workouts',
      icon: 'dumbbell',
      description: 'Strength, cardio, yoga — track date, kind, duration.',
      schema: {
        headers: ['id','date','kind','duration','notes','_updated'],
        types:   ['text','date','select(strength,cardio,yoga,mobility,other)','duration','longtext','datetime']
      },
      defaultSort: 'date:desc'
    },
    {
      slug: 'papers',
      title: 'Papers',
      icon: 'file-text',
      description: 'Research papers — auto-fetches title, authors, year, venue, DOI, abstract, PDF link from arXiv or any DOI. Add an arXiv id, DOI, or paper URL and Minerva fills the rest.',
      schema: {
        headers: ['id','title','authors','year','venue','volume','pages','doi','url','pdf','abstract','category','tags','read','notes','_updated'],
        types:   ['text','text','text','number','text','text','text','text','link','link','markdown','multiselect(method,review,dataset,benchmark,position,survey,theory,application,other)','multiselect()','check','markdown','datetime']
      }
    },
    {
      slug: 'contacts',
      title: 'Contacts',
      icon: 'users',
      description: 'People — name, email, phone, tags, notes.',
      schema: {
        headers: ['id','name','email','tel','tags','notes','_updated'],
        types:   ['text','text','email','tel','multiselect()','markdown','datetime']
      }
    },
    {
      slug: 'travel',
      title: 'Travel',
      icon: 'plane',
      description: 'Trips with dates and notes.',
      schema: {
        headers: ['id','where','start','end','notes','_updated'],
        types:   ['text','text','date','date','markdown','datetime']
      },
      defaultSort: 'start:desc'
    },
    {
      slug: 'recipes',
      title: 'Recipes',
      icon: 'chef-hat',
      description: 'Recipes worth keeping — meal category, tags, ingredients + steps as markdown.',
      schema: {
        headers: ['id','title','category','tags','ingredients','steps','_updated'],
        types:   ['text','text','multiselect(breakfast,lunch,dinner,snack,dessert,drink,sauce,baking,other)','multiselect()','longtext','markdown','datetime']
      }
    },
    {
      slug: 'inbox',
      title: 'Inbox',
      icon: 'inbox',
      description: 'Quick-capture target — anything you don\'t know where to put yet.',
      schema: {
        headers: ['id','title','body','tags','created','_updated'],
        types:   ['text','text','markdown','multiselect()','datetime','datetime']
      },
      defaultSort: 'created:desc'
    },
    {
      slug: 'jobs',
      title: 'Job applications',
      icon: 'briefcase',
      description: 'Companies, roles, application status, contacts.',
      schema: {
        headers: ['id','company','role','applied','status','url','contacts','notes','_updated'],
        types:   ['text','text','text','date','select(applied,interviewing,offer,rejected,withdrawn)','link','ref(contacts,multi)','markdown','datetime']
      },
      defaultSort: 'applied:desc'
    },
    {
      slug: 'pomodoros',
      title: 'Pomodoros',
      icon: 'timer',
      description: 'Logged focus sessions from the floating Pomodoro timer (auto-populated when this tab exists).',
      schema: {
        headers: ['id','started','ended','duration','note','_updated'],
        types:   ['text','datetime','datetime','duration','text','datetime']
      },
      defaultSort: 'started:desc'
    },
    {
      slug: 'library',
      title: 'Library',
      icon: 'library',
      description: 'Unified reading + watch list — papers, articles, videos, books. Pairs with the "+ from URL" button to auto-fetch arXiv, DOI (CrossRef), and YouTube metadata.',
      schema: {
        headers: ['id','kind','title','authors','year','venue','url','pdf','abstract','tags','read','rating','notes','_updated'],
        types:   ['text','select(paper,article,book,video,podcast)','text','text','number','text','link','link','markdown','multiselect()','check','rating(0..5)','markdown','datetime']
      },
      defaultSort: '_updated:desc'
    },
    {
      slug: 'events',
      title: 'Events',
      icon: 'calendar',
      description: 'Calendar-style events with start + end datetimes. The Schedule view (Today → Schedule) reads these to compute free time and shareable availability.',
      schema: {
        headers: ['id','title','start','end','location','notes','_updated'],
        types:   ['text','text','datetime','datetime','text','markdown','datetime']
      },
      defaultSort: 'start'
    },
    {
      slug: 'meets',
      title: 'Meeting polls',
      icon: 'users',
      description: 'Archive of When-to-meet group polls you have created. The + button opens the When-to-meet builder; saved polls show up here with their response URL so you can re-share later.',
      schema: {
        headers: ['id','title','url','days','slots','responses','status','note','created','_updated'],
        types:   ['text','text','link','text','text','number','select(open,closed)','markdown','datetime','datetime']
      },
      defaultSort: 'created:desc'
    },
    // Sketches preset removed in favour of the sketch column on Notes.
    {
      slug: 'youtube',
      title: 'YouTube tracker',
      icon: 'youtube',
      description: 'Track YouTube videos with playlist grouping and offline support: title, channel, playlist, duration, watch state, rating. Paste a single video URL or a playlist URL (?list=… — needs a free Data API key in Settings) and Minerva enumerates every video, fetches durations, and groups videos by playlist. Each row gets Save offline (attach a downloaded mp4 — stored locally for distraction-free playback).',
      schema: {
        headers: ['id','title','channel','playlist','category','url','duration','published','watched','watched_at','rating','tags','notes','offline','_updated'],
        types:   ['text','text','text','text','multiselect(tutorial,talk,lecture,documentary,course,interview,music,news,vlog,other)','link','text','date','check','datetime','rating(0..5)','multiselect()','markdown','text','datetime']
      },
      defaultSort: 'published:desc'
    },
    {
      slug: 'proposals',
      title: 'Proposals',
      icon: 'file-pen-line',
      description: 'Research and grant proposals — funder, deadline, status, and the structured sections reviewers expect. See docs/proposal-guide.md for funder-by-funder rules.',
      schema: {
        headers: ['id','title','funder','program','deadline','status','abstract','aims','methods','broader_impacts','timeline','budget','notes','_updated'],
        types:   ['text','text','select(NSF,NIH,ERC,DOE,DARPA,internal,foundation,other)','text','date','select(planning,drafting,review,submitted,accepted,rejected,revising,awarded)','markdown','markdown','markdown','markdown','markdown','markdown','markdown','datetime']
      },
      defaultSort: 'deadline'
    }
  ];

  window.Minerva = window.Minerva || {};
  window.Minerva.presets = PRESETS;
})();
