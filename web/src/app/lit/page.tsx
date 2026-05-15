/**
 * lit.thefarshad.com — a stateless literature explorer. Visitors
 * paste an arXiv ID / DOI / paper URL / title, see the resolved
 * metadata, and (in a follow-up) browse the citation graph.
 *
 * No auth, no DB writes, no personal papers shown. Reuses
 * Minerva's existing public lookup endpoint (/api/import/lookup,
 * now unauthenticated) to resolve metadata across arXiv, CrossRef,
 * Europe PMC, and generic publisher citation_* scraping.
 *
 * Served at lit.thefarshad.com by the Host-based middleware
 * rewrite, or directly at minerva.thefarshad.com/lit.
 */
import { LitExplorer } from './lit-explorer';

export const metadata = { title: 'Literature' };
export const dynamic = 'force-static';

export default function LitPage() {
  return <LitExplorer />;
}
