import '@neometaharness/ui/styles.css';
import React, { useState, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell, NeoTheme, SideNav, SideNavItem, SideNavSection } from '@neometaharness/ui/shell';
import { Markdown } from '@neometaharness/ui';
import { DOC_ITEMS, DOC_SECTIONS, DOC_BY_SLUG, type DocItem } from './content';
import './docs.css';

function normalizePath(raw: string): string {
  const clean = raw.split('#')[0].split('?')[0];
  if (clean === '' || clean === '/') return '/user-guide';
  return clean.endsWith('/') ? clean.slice(0, -1) : clean;
}

function resolveInternalTarget(href: string): { slug?: string; hash?: string } {
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
    return {};
  }
  const [pathPart, hashPart] = href.split('#');
  const hash = hashPart ? ('#' + hashPart) : undefined;

  // Direct slug match
  if (pathPart && DOC_BY_SLUG[pathPart]) {
    return { slug: pathPart, hash };
  }

  // File mapping from docs/*.md relative links
  for (const doc of DOC_ITEMS) {
    if (pathPart && (doc.sourceFile.endsWith(pathPart) || pathPart.endsWith(doc.sourceFile))) {
      return { slug: doc.slug, hash };
    }
    const filename = doc.sourceFile.split('/').pop();
    if (pathPart && filename && pathPart.endsWith(filename)) {
      return { slug: doc.slug, hash };
    }
  }

  if (!pathPart && hashPart) {
    return { hash };
  }

  return {};
}

function NeoDocsApp() {
  const [currentSlug, setCurrentSlug] = useState<string>(() => {
    const norm = normalizePath(window.location.pathname);
    return DOC_BY_SLUG[norm] ? norm : '/user-guide';
  });
  const [filterQuery, setFilterQuery] = useState('');

  useEffect(() => {
    const handlePopState = () => {
      const norm = normalizePath(window.location.pathname);
      if (DOC_BY_SLUG[norm]) {
        setCurrentSlug(norm);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const currentDoc: DocItem = useMemo(() => {
    return DOC_BY_SLUG[currentSlug] || DOC_ITEMS[0];
  }, [currentSlug]);

  const navigateTo = (slug: string, hash?: string) => {
    if (slug !== currentSlug) {
      window.history.pushState({}, '', slug + (hash || ''));
      setCurrentSlug(slug);
      window.scrollTo(0, 0);
    }
    if (hash) {
      setTimeout(() => {
        const id = hash.replace(/^#/, '');
        const el = document.getElementById(id) || document.querySelector('[name="' + id + '"]');
        el?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    }
  };

  const handleLinkClick = (href: string, e: React.MouseEvent<HTMLAnchorElement>) => {
    const resolved = resolveInternalTarget(href);
    if (resolved.slug || resolved.hash) {
      e.preventDefault();
      navigateTo(resolved.slug || currentSlug, resolved.hash);
      return false;
    }
  };

  const filteredSections = useMemo(() => {
    if (!filterQuery.trim()) return DOC_SECTIONS;
    const q = filterQuery.toLowerCase();
    return DOC_SECTIONS.map((sec) => ({
      ...sec,
      items: sec.items.filter(
        (item) => item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
      ),
    })).filter((sec) => sec.items.length > 0);
  }, [filterQuery]);

  return (
    <NeoTheme>
      <AppShell
        variant="section"
        contentPadding={0}
        sideNav={
          <SideNav
            header={
              <div>
                <div className="neo-docs-nav-heading">
                  <strong>Neo Meta Harness</strong>
                  <span>Documentation</span>
                </div>
                <div className="neo-docs-search-box">
                  <input
                    type="search"
                    data-testid="docs-search-input"
                    className="neo-docs-search-input"
                    placeholder="Search docs..."
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                  />
                </div>
              </div>
            }
          >
            {filteredSections.map((sec) => (
              <SideNavSection key={sec.id} title={sec.title}>
                {sec.items.map((item) => (
                  <SideNavItem
                    key={item.id}
                    label={item.title}
                    href={item.slug}
                    isSelected={currentSlug === item.slug}
                    onClick={(e) => {
                      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      navigateTo(item.slug);
                    }}
                  />
                ))}
              </SideNavSection>
            ))}
          </SideNav>
        }
      >
        <div className="docs-page-container">
          <main className="docs-main-content" data-testid="docs-content">
            <header className="docs-header">
              <div className="docs-meta-row">
                <span className="docs-badge" data-testid="docs-section-badge">
                  {currentDoc.sectionTitle}
                </span>
                <span className="docs-source-tag">{currentDoc.sourceFile}</span>
              </div>
              <h1 data-testid="docs-title">{currentDoc.title}</h1>
              <p className="docs-header-desc">{currentDoc.description}</p>
            </header>

            <article className="docs-markdown-body">
              <Markdown onLinkClick={handleLinkClick}>
                {currentDoc.content}
              </Markdown>
            </article>
          </main>

          {currentDoc.headings.length > 0 && (
            <aside className="docs-toc-sidebar" aria-label="Table of contents">
              <div className="docs-toc-title">On this page</div>
              <ul className="docs-toc-list">
                {currentDoc.headings
                  .filter((h) => h.level >= 2 && h.level <= 3)
                  .map((h) => (
                    <li key={h.id}>
                      <a
                        href={'#' + h.id}
                        className={'docs-toc-link level-' + h.level}
                        onClick={(e) => {
                          e.preventDefault();
                          navigateTo(currentSlug, '#' + h.id);
                        }}
                      >
                        {h.text}
                      </a>
                    </li>
                  ))}
              </ul>
            </aside>
          )}
        </div>
      </AppShell>
    </NeoTheme>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<NeoDocsApp />);
}
