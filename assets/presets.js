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
      icon: '📚',
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
      icon: '📔',
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
      icon: '⚖️',
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
      icon: '📖',
      description: 'Books you\'re reading or have finished, with start/finish dates and a rating.',
      schema: {
        headers: ['id','title','author','started','finished','rating','notes','_updated'],
        types:   ['text','text','text','date','date','rating(0..5)','markdown','datetime']
      }
    },
    {
      slug: 'films',
      title: 'Films',
      icon: '🎬',
      description: 'Films watched with date, rating, and notes.',
      schema: {
        headers: ['id','title','watched','rating','notes','_updated'],
        types:   ['text','text','date','rating(0..5)','markdown','datetime']
      },
      defaultSort: 'watched:desc'
    },
    {
      slug: 'workouts',
      title: 'Workouts',
      icon: '🏋️',
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
      icon: '📄',
      description: 'Research papers — title, authors, year, URL, read flag, notes.',
      schema: {
        headers: ['id','title','authors','year','url','read','notes','_updated'],
        types:   ['text','text','text','number','link','check','markdown','datetime']
      }
    },
    {
      slug: 'contacts',
      title: 'Contacts',
      icon: '👥',
      description: 'People — name, email, phone, tags, notes.',
      schema: {
        headers: ['id','name','email','tel','tags','notes','_updated'],
        types:   ['text','text','email','tel','multiselect()','markdown','datetime']
      }
    },
    {
      slug: 'travel',
      title: 'Travel',
      icon: '✈️',
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
      icon: '🍳',
      description: 'Recipes worth keeping — ingredients + steps as markdown.',
      schema: {
        headers: ['id','title','tags','ingredients','steps','_updated'],
        types:   ['text','text','multiselect()','longtext','markdown','datetime']
      }
    },
    {
      slug: 'inbox',
      title: 'Inbox',
      icon: '📥',
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
      icon: '💼',
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
      icon: '🍅',
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
      icon: '📚',
      description: 'Unified reading + watch list — papers, articles, videos, books. Pairs with the "+ from URL" button to auto-fetch arXiv, DOI (CrossRef), and YouTube metadata.',
      schema: {
        headers: ['id','kind','title','authors','year','venue','url','pdf','abstract','tags','read','rating','notes','_updated'],
        types:   ['text','select(paper,article,book,video,podcast)','text','text','number','text','link','link','markdown','multiselect()','check','rating(0..5)','markdown','datetime']
      },
      defaultSort: '_updated:desc'
    },
    {
      slug: 'proposals',
      title: 'Proposals',
      icon: '📑',
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
