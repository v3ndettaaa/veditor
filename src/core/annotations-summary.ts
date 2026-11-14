import type { Annotation, DocumentSession } from './types';

export type AnnotationFilterCategory = 'all' | 'ink' | 'text' | 'shapes';

export function describeAnnotationItem(ann: Annotation, lang: 'en' | 'fa' = 'en'): {
  title: string;
  subtitle: string;
  icon: string;
  color: string;
  category: Exclude<AnnotationFilterCategory, 'all'>;
} {
  const fa = lang === 'fa';
  switch (ann.type) {
    case 'highlighter':
      return {
        title: fa ? 'هایلایت' : 'Highlight',
        subtitle: `${ann.points?.length || 0} ${fa ? 'نقطه' : 'pts'}`,
        icon: 'highlighter',
        color: ann.color || '#facc15',
        category: 'ink'
      };
    case 'pen':
      return {
        title: fa ? 'دست‌خط آزاد' : 'Ink Stroke',
        subtitle: `${ann.strokeWidth}px · ${ann.points?.length || 0} ${fa ? 'نقطه' : 'pts'}`,
        icon: 'pen',
        color: ann.color || '#3b82f6',
        category: 'ink'
      };
    case 'text':
      return {
        title: (ann.text || '').trim() || (fa ? 'کادر متن خالی' : 'Empty Text Box'),
        subtitle: fa ? 'کادر متن' : 'Text Box',
        icon: 'type',
        color: ann.color || '#111827',
        category: 'text'
      };
    case 'sticky-note':
      return {
        title: (ann.text || '').trim() || (fa ? 'یادداشت بدون متن' : 'Untitled Sticky Note'),
        subtitle: ann.author ? `${fa ? 'یادداشت' : 'Sticky Note'} · ${ann.author}` : (fa ? 'یادداشت چسبان' : 'Sticky Note'),
        icon: 'stickyNote',
        color: ann.color || '#fef08a',
        category: 'text'
      };
    case 'stamp': {
      const isCustomImg = ann.stampType === 'custom' || Boolean(ann.imageUrl);
      return {
        title: isCustomImg
          ? (ann.presetKey || (fa ? 'تصویر سفارشی' : 'Custom Image'))
          : (ann.presetKey || 'STAMP').toUpperCase(),
        subtitle: isCustomImg ? (fa ? 'تصویر درج‌شده' : 'Inserted Image') : (fa ? 'مهر' : 'Stamp'),
        icon: isCustomImg ? 'imagePlus' : 'stamp',
        color: ann.color || '#8b5cf6',
        category: 'shapes'
      };
    }
    case 'signature':
      return {
        title: fa ? 'امضای دیجیتال' : 'Digital Signature',
        subtitle: `${Math.round(ann.box.width)}×${Math.round(ann.box.height)} pt`,
        icon: 'signature',
        color: ann.color || '#0ea5e9',
        category: 'shapes'
      };
    case 'measure-distance':
    case 'measure-area':
    case 'measure-angle': {
      const unitStr = ann.type === 'measure-angle' ? '°' : ann.type === 'measure-area' ? `${ann.unit}²` : ann.unit;
      const valNum = Number.isFinite(ann.measuredValue) ? ann.measuredValue : 0;
      const valStr = ann.label || `${valNum.toFixed(ann.type === 'measure-angle' ? 1 : 2)} ${unitStr}`;
      const labelMap: Record<string, string> = {
        'measure-distance': fa ? 'اندازه فاصله' : 'Distance',
        'measure-area': fa ? 'اندازه مساحت' : 'Area',
        'measure-angle': fa ? 'اندازه زاویه' : 'Angle'
      };
      return {
        title: `${labelMap[ann.type]}: ${valStr}`,
        subtitle: `${fa ? 'مقیاس' : 'Scale'} ${ann.scaleRatio}`,
        icon: ann.type === 'measure-area' ? 'measureArea' : ann.type === 'measure-angle' ? 'measureAngle' : 'measureDistance',
        color: ann.color || '#ef4444',
        category: 'shapes'
      };
    }
    default: {
      const shapeNames: Record<string, [string, string]> = {
        rectangle: ['Rectangle', 'مستطیل'],
        ellipse: ['Ellipse', 'دایره / بیضی'],
        line: ['Line', 'خط صاف'],
        arrow: ['Arrow', 'پیکان (فلش)'],
        polygon: ['Polygon', 'چندضلعی'],
        'freeform-shape': ['Freeform Shape', 'شکل آزاد']
      };
      const pair = shapeNames[ann.type] || [ann.type, ann.type];
      return {
        title: fa ? pair[1] : pair[0],
        subtitle: `${Math.round(ann.box.width)}×${Math.round(ann.box.height)} pt`,
        icon: ann.type === 'ellipse' ? 'circle' : ann.type === 'arrow' ? 'arrowUpRight' : ann.type === 'line' ? 'minus' : 'square',
        color: ann.strokeColor || '#3b82f6',
        category: 'shapes'
      };
    }
  }
}

/**
 * Pure helper that builds a structured Markdown summary of all annotations and
 * user bookmarks in a document for copying or exporting as `.md`.
 */
export function buildAnnotationsMarkdownSummary(
  doc: Pick<DocumentSession, 'name' | 'pageCount' | 'annotations' | 'userBookmarks'>,
  lang: 'en' | 'fa' = 'en'
): string {
  const fa = lang === 'fa';
  const lines: string[] = [];
  lines.push(`# ${doc.name || (fa ? 'خلاصه حاشیه‌نویسی‌ها' : 'Annotations Summary')}`);
  lines.push('');

  const bookmarks = doc.userBookmarks || [];
  if (bookmarks.length > 0) {
    lines.push(`## ${fa ? 'نشانک‌ها' : 'Bookmarks'} (${bookmarks.length})`);
    for (const bm of bookmarks) {
      const pageLabel = fa ? `صفحه ${bm.pageIndex + 1}` : `Page ${bm.pageIndex + 1}`;
      lines.push(`- **[${pageLabel}] ${bm.title}**${bm.note ? ` — _${bm.note}_` : ''}`);
    }
    lines.push('');
  }

  const pageIndices = Object.keys(doc.annotations || {})
    .map(Number)
    .filter((idx) => Number.isFinite(idx) && Array.isArray(doc.annotations[idx]) && doc.annotations[idx].length > 0)
    .sort((a, b) => a - b);

  if (pageIndices.length === 0) {
    lines.push(fa ? '_هیچ حاشیه‌نویسی ثبت نشده است._' : '_No annotations recorded._');
    return lines.join('\n');
  }

  for (const pageIdx of pageIndices) {
    const anns = doc.annotations[pageIdx] || [];
    lines.push(`## ${fa ? `صفحه ${pageIdx + 1}` : `Page ${pageIdx + 1}`} (${anns.length})`);
    for (const ann of anns) {
      const info = describeAnnotationItem(ann, lang);
      lines.push(`- **${info.title}** (${info.subtitle})`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
