/* 소설 작업실 — docx.js
 * DOCX 만들기/읽기, HWPX 읽기. JSZip을 인자로 받는다(브라우저는 CDN 전역, 테스트는 npm). */
(function (root, factory) {
  const m = factory(typeof self !== 'undefined' && self.NSCore ? self.NSCore : require('./core.js'));
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  else root.NSDocx = m;
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const para = (text, style) =>
    '<w:p>' + (style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '') +
    (text === '' ? '' : `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`) + '</w:p>';

  // 원고를 DOCX(ArrayBuffer/Blob용 Uint8Array)로 만든다. 장 제목은 제목 1 스타일.
  async function buildDocx(JSZip, ver, workTitle) {
    const body = [];
    if (workTitle) body.push(para(workTitle, 'Title'));
    for (const ch of ver.chapters) {
      if (ch.title) body.push(para(ch.title, 'Heading1'));
      for (const p of ch.paragraphs) body.push(para(p.text));
    }
    const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${ns}>` +
      `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Batang" w:hAnsi="Batang" w:eastAsia="바탕" w:cs="Batang"/><w:sz w:val="22"/><w:lang w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
      `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="480"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="480" w:after="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>`;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    zip.file('word/document.xml', doc);
    zip.file('word/styles.xml', styles);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  async function readDocx(JSZip, buf) {
    const zip = await JSZip.loadAsync(buf);
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('DOCX 안에서 word/document.xml을 찾지 못했습니다. 파일이 손상되었거나 .doc(구형)일 수 있습니다.');
    return C.docxXmlToParas(await f.async('string'));
  }
  async function readHwpx(JSZip, buf) {
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/i.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    if (!names.length) throw new Error('HWPX 안에서 본문(Contents/section*.xml)을 찾지 못했습니다.');
    let out = [];
    for (const n of names) out = out.concat(C.hwpxXmlToParas(await zip.file(n).async('string')));
    return out;
  }
  return { buildDocx, readDocx, readHwpx };
});
