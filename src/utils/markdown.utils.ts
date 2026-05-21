// Lightweight markdown-to-HTML converter (no external dependency).
// Supports: headings (#, ##, ###), lists (- / *, 1.), paragraphs, hr (---),
// inline `code`, **bold**, *italic*, _italic_, [text](url) links.
// Output HTML is always sanitized via sanitizeHtmlContent before being injected.

export function markdownToHtml(md: string): string {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const htmlLines: string[] = [];
  let inList = false;
  let listType: 'ul' | 'ol' = 'ul';

  const inline = (text: string): string => text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const closeList = () => {
    if (inList) {
      htmlLines.push(listType === 'ul' ? '</ul>' : '</ol>');
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      closeList();
      htmlLines.push('<hr/>');
      continue;
    }
    if (line.startsWith('### ')) {
      closeList();
      htmlLines.push(`<h3>${inline(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith('## ')) {
      closeList();
      htmlLines.push(`<h2>${inline(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith('# ')) {
      closeList();
      htmlLines.push(`<h1>${inline(line.slice(2))}</h1>`);
      continue;
    }

    const ulMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        closeList();
        htmlLines.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      htmlLines.push(`<li>${inline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        closeList();
        htmlLines.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      htmlLines.push(`<li>${inline(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    if (trimmed === '') continue;
    htmlLines.push(`<p>${inline(line)}</p>`);
  }
  closeList();

  return htmlLines.join('\n');
}