import React, { useEffect, useState, useCallback } from 'react';
import classNames from 'classnames/bind';
import styles from './news-modal.component.css';

const cx = classNames.bind(styles);

const NEWS_MD_URL =
  'https://raw.githubusercontent.com/galdo/aurora/refs/heads/main/docs/news.md';
const NEWS_IMG_URL =
  'https://raw.githubusercontent.com/galdo/aurora/refs/heads/main/docs/news.png';

const STORAGE_KEY = 'aurora-news-dismissed';

function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const htmlLines: string[] = [];
  let inList = false;
  let listType = '';

  const inline = (text: string): string => {
    return text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      if (inList) { htmlLines.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
      htmlLines.push('<hr/>');
      continue;
    }
    if (line.startsWith('### ')) {
      if (inList) { htmlLines.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
      htmlLines.push(`<h3>${inline(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith('## ')) {
      if (inList) { htmlLines.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
      htmlLines.push(`<h2>${inline(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith('# ')) {
      if (inList) { htmlLines.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; }
      htmlLines.push(`<h1>${inline(line.slice(2))}</h1>`);
      continue;
    }
    if (/^[\s]*[-*]\s+/.test(line)) {
      const content = line.replace(/^[\s]*[-*]\s+/, '');
      if (!inList || listType !== 'ul') {
        if (inList) htmlLines.push(listType === 'ul' ? '</ul>' : '</ol>');
        htmlLines.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      htmlLines.push(`<li>${inline(content)}</li>`);
      continue;
    }
    if (/^[\s]*\d+\.\s+/.test(line)) {
      const content = line.replace(/^[\s]*\d+\.\s+/, '');
      if (!inList || listType !== 'ol') {
        if (inList) htmlLines.push(listType === 'ul' ? '</ul>' : '</ol>');
        htmlLines.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      htmlLines.push(`<li>${inline(content)}</li>`);
      continue;
    }
    if (inList) {
      htmlLines.push(listType === 'ul' ? '</ul>' : '</ol>');
      inList = false;
    }
    if (line.trim() === '') continue;
    htmlLines.push(`<p>${inline(line)}</p>`);
  }
  if (inList) htmlLines.push(listType === 'ul' ? '</ul>' : '</ol>');
  return htmlLines.join('\n');
}

export function NewsModal() {
  const [visible, setVisible] = useState(false);
  const [markdownHtml, setMarkdownHtml] = useState('');
  const [loading, setLoading] = useState(true);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    const dismissed = localStorage.getItem(STORAGE_KEY);
    if (dismissed === 'true') return;
    setVisible(true);
    fetch(NEWS_MD_URL)
      .then((res) => { if (!res.ok) throw new Error('Failed'); return res.text(); })
      .then((md) => { setMarkdownHtml(markdownToHtml(md)); setLoading(false); })
      .catch(() => { setMarkdownHtml('<p>Could not load news content.</p>'); setLoading(false); });
  }, []);

  const handleClose = useCallback(() => {
    if (dontShowAgain) localStorage.setItem(STORAGE_KEY, 'true');
    setVisible(false);
  }, [dontShowAgain]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleClose();
  }, [handleClose]);

  const handleDontShowAgainChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => { setDontShowAgain(e.target.checked); }, []
  );

  if (!visible) return null;

  return (
    <div className={cx('overlay')} onClick={handleBackdropClick}>
      <div className={cx('modal')}>
        <div className={cx('header')}>
          <h2 className={cx('title')}>What&apos;s New</h2>
          <button className={cx('close-btn')} onClick={handleClose} aria-label="Close">✕</button>
        </div>
        <div className={cx('body')}>
          <div className={cx('content')}>
            {loading
              ? <div className={cx('loading')}>Loading news...</div>
              : <div className={cx('markdown')} dangerouslySetInnerHTML={{ __html: markdownHtml }}/>
            }
          </div>
          <div className={cx('image-container')}>
            <img className={cx('image')} src={NEWS_IMG_URL} alt="News" loading="lazy"/>
          </div>
        </div>
        <div className={cx('footer')}>
          <label className={cx('checkbox-label')}>
            <input type="checkbox" checked={dontShowAgain} onChange={handleDontShowAgainChange} className={cx('checkbox')}/>
            Don&apos;t show news on startup
          </label>
          <button className={cx('dismiss-btn')} onClick={handleClose}>Close</button>
        </div>
      </div>
    </div>
  );
}