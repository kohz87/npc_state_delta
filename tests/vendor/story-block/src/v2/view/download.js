/** Save a text file using the page's download link, then release its temporary URL. */
export function saveTextFile(doc, text, name, type = 'text/plain;charset=utf-8') {
    const win = doc.defaultView ?? globalThis;
    const blob = new win.Blob([text], { type });
    const url = win.URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    doc.body.appendChild(link);
    try { link.click(); } finally {
        link.remove();
        setTimeout(() => win.URL.revokeObjectURL(url), 1000);
    }
}
