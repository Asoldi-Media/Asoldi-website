import React, { useEffect, useRef, useState } from 'react';
import { LayoutGrid } from 'lucide-react';
import grapesjs, { type Editor } from 'grapesjs';
import presetNewsletter from 'grapesjs-preset-newsletter';
import 'grapesjs/dist/css/grapes.min.css';
import './email-editor.css';

function isPhoneViewport() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
}

export type MergeField = { token: string; label: string; sample?: string };

type Props = {
  html: string;
  htmlKey?: string;
  grapesProject?: unknown;
  mergeFields?: MergeField[];
  onHtmlChange?: (html: string) => void;
  onProjectChange?: (project: Record<string, unknown>) => void;
};

const BLOCK_LABELS: Record<string, string> = {
  sect100: 'Rad 100%',
  sect50: 'Rad 50 / 50',
  sect30: 'Rad 3 kolonner',
  sect37: 'Rad 30 / 70',
  button: 'Knapp',
  divider: 'Skillelinje',
  text: 'Tekst',
  'text-sect': 'Overskrift + tekst',
  image: 'Bilde',
  quote: 'Sitat',
  'grid-items': 'Rutenett',
  'list-items': 'Liste',
};

function inlinedHtml(editor: Editor) {
  try {
    const html = editor.runCommand('gjs-get-inlined-html');
    if (typeof html === 'string' && html.trim()) return html;
  } catch {
    // fall through
  }
  return editor.getHtml();
}

function loadCanvas(editor: Editor, html: string, grapesProject?: unknown) {
  if (grapesProject && typeof grapesProject === 'object') {
    editor.loadProjectData(grapesProject as Record<string, unknown>);
    return;
  }
  editor.setComponents(html || '');
}

export function EmailVisualEditor({
  html,
  htmlKey = '',
  grapesProject,
  mergeFields = [],
  onHtmlChange,
  onProjectChange,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onHtmlChange);
  const onProjectRef = useRef(onProjectChange);
  const [blocksOpen, setBlocksOpen] = useState(false);
  onChangeRef.current = onHtmlChange;
  onProjectRef.current = onProjectChange;

  useEffect(() => {
    rootRef.current?.classList.toggle('is-blocks-open', blocksOpen);
    const editor = editorRef.current;
    if (!editor) return;
    try {
      editor.Panels.getButton('views', 'open-blocks')?.set('active', blocksOpen);
      editor.refresh();
    } catch {
      // Panel IDs differ across GrapesJS presets; CSS still shows/hides the block tray.
    }
  }, [blocksOpen]);

  useEffect(() => {
    if (!rootRef.current) return undefined;
    const phone = isPhoneViewport();
    const editor = grapesjs.init({
      container: rootRef.current,
      height: '100%',
      fromElement: false,
      storageManager: false,
      noticeOnUnload: false,
      undoManager: { trackSelection: false },
      plugins: [(instance) => presetNewsletter(instance, {
        modalTitleImport: 'Importer HTML',
        modalTitleExport: 'Eksporter HTML',
        modalLabelImport: 'Lim inn HTML fra Brevo, GrapesJS eller en annen editor. Bildelenker bør være absolutte.',
        modalLabelExport: 'Kopier den inlinede HTML-en og lim den inn der du trenger den.',
        modalBtnImport: 'Importer',
        importPlaceholder: '<table width="100%" role="presentation"><tr><td style="padding:24px;font-family:Arial">Hei {{firstName}},</td></tr></table>',
        showBlocksOnLoad: !phone,
        showStylesOnChange: true,
        useCustomTheme: false,
        textCleanCanvas: 'Tøm hele e-posten?',
        block: (id: string) => (BLOCK_LABELS[id] ? { label: BLOCK_LABELS[id] } : {}),
      })],
      deviceManager: {
        devices: [
          { id: 'desktop', name: 'PC', width: '' },
          { id: 'tablet', name: 'Nettbrett', width: '768px', widthMedia: '768px' },
          { id: 'mobile', name: 'Telefon', width: phone ? '100%' : '390px', widthMedia: '480px' },
        ],
      },
      assetManager: {
        embedAsBase64: false,
        assets: [
          '/email/sales/hero-banner.jpg',
          '/email/sales/hero-mobile.jpg',
          '/email/sales/envelope.png',
          '/email/sales/logo-mark.png',
          '/email/sales/logo-mark-orange.png',
          '/email/sales/christopher.png',
          '/email/sales/customers-badge.png',
          '/email/sales/icon-facebook.png',
          '/email/sales/icon-instagram.png',
          '/email/sales/icon-youtube.png',
        ],
      },
      canvas: {
        styles: [],
      },
      richTextEditor: {
        adjustToolbar: true,
      },
    });

    editor.BlockManager.add('email-canvas-600', {
      label: 'Bredde 600px',
      category: 'Layout',
      content: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tr>
          <td style="padding:24px;font-family:Arial,Helvetica,sans-serif;color:#111111;font-size:16px;line-height:1.5;">
            Dobbeltklikk for å redigere denne teksten.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`,
    });

    mergeFields.forEach((field) => {
      editor.BlockManager.add(`merge-${field.token}`, {
        label: field.label,
        category: 'Flettefelt',
        content: `<span data-merge="${field.token}">${field.token}</span>`,
      });
    });

    const emit = () => {
      onChangeRef.current?.(inlinedHtml(editor));
      onProjectRef.current?.(editor.getProjectData() as Record<string, unknown>);
    };
    editor.on('update', emit);
    editor.on('load', () => {
      loadCanvas(editor, html, grapesProject);
      if (phone) {
        try {
          editor.setDevice('mobile');
          editor.Panels.getButton('views', 'open-blocks')?.set('active', false);
        } catch {
          // Keep the canvas visible even if device/panel APIs differ.
        }
      }
      emit();
      editor.refresh();
    });

    editorRef.current = editor;
    return () => {
      editor.destroy();
      editorRef.current = null;
    };
  }, [htmlKey]);

  function insertToken(token: string) {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      editor.RichTextEditor.insert(token);
      return;
    } catch {
      editor.addComponents(`<span>${token}</span>`);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-[360px] sm:min-h-[620px] gap-2 sm:gap-3">
      <div className="flex items-center justify-between gap-2 sm:hidden">
        <button
          type="button"
          onClick={() => setBlocksOpen((open) => !open)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/10 text-xs text-gray-200"
        >
          <LayoutGrid size={12} /> {blocksOpen ? 'Skjul blokker' : 'Blokker'}
        </button>
      </div>
      {mergeFields.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {mergeFields.map((field) => (
            <button
              key={field.token}
              type="button"
              onClick={() => insertToken(field.token)}
              className="px-2 py-1 rounded-full text-[11px] bg-white/10 hover:bg-[#FF5B00] text-gray-200"
              title={field.sample ? `Eksempel: ${field.sample}` : field.token}
            >
              {field.label}
            </button>
          ))}
        </div>
      )}
      <div ref={rootRef} className={`email-gjs flex-1 ${blocksOpen ? 'is-blocks-open' : ''}`} />
      <p className="hidden sm:block text-[11px] text-gray-500">
        Dra blokker inn i malen, flytt seksjoner, og klikk tekst for å redigere. PC / telefon bytter du øverst i editoren.
      </p>
    </div>
  );
}
