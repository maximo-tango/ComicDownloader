// Sequential original-image viewer. Navigation follows the current list order
// (discovery order or the chosen sort), never file names.

import { $, h, toast } from './common.js';
import { badges, dimsText, displayName, statusBadge } from './item-format.js';
import { SOURCE_LABEL } from '../lib/resolver.js';

export function createViewer(api) {
  const root = $('#viewer');
  const img = $('#vImg');
  const stage = $('#vStage');
  let list = [];
  let index = 0;
  let token = 0;
  let lastDir = 1;

  function open(startId) {
    list = api.getList();
    if (!list.length) {
      toast('표시할 이미지가 없습니다. 필터를 확인하세요.');
      return;
    }
    index = Math.max(0, list.findIndex((i) => i.id === startId));
    $('#vNoThumb').checked = api.getExcludeThumbs();
    $('#vAutoSkip').checked = api.getAutoSkip();
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    show();
  }

  function close() {
    root.hidden = true;
    document.body.style.overflow = '';
    img.removeAttribute('src');
    token++;
  }

  /** Called when filters/sort change while the viewer is open. */
  function refresh() {
    if (root.hidden) return;
    const current = list[index]?.id;
    list = api.getList();
    if (!list.length) return close();
    const i = list.findIndex((x) => x.id === current);
    if (i >= 0) {
      index = i;
      renderInfo();
    } else {
      index = Math.min(index, list.length - 1);
      show();
    }
  }

  function renderInfo() {
    const item = list[index];
    $('#vCounter').textContent = `이미지 ${index + 1} / ${list.length}`;
    const st = statusBadge(item);
    const vStatus = $('#vStatus');
    vStatus.textContent = st.label;
    vStatus.title = st.tip;
    vStatus.className = `badge ${st.cls}`;
    $('#vDims').replaceChildren(h('span', {}, dimsText(item)), ...badges(item));
    $('#vName').textContent = displayName(item);
    const a = $('#vUrl');
    a.href = item.originalUrl;
    a.textContent = item.originalUrl.startsWith('data:') ? '(data URL)' : item.originalUrl;
    $('#vSelect').checked = api.isSelected(item.id);
    const ol = $('#vCandidates ol');
    ol.replaceChildren(
      ...(item.candidates || []).map((c) =>
        h(
          'li',
          { class: c.chosen ? 'chosen' : '' },
          `${c.chosen ? '✔ ' : ''}[${SOURCE_LABEL[c.kind] || c.kind}${c.rule ? ':' + c.rule : ''}] `,
          c.ok ? (c.width ? `${c.width}×${c.height} ` : '해상도 미확인 ') : `✗ ${c.error || '실패'} `,
          h('span', { title: c.url }, c.url.startsWith('data:') ? '(data URL)' : c.url),
        ),
      ),
    );
    $('#vCandidates summary').textContent = `원본 후보 ${item.candidates?.length || 0}개 (출처 · 실제 해상도)`;
    $('#vPrev').disabled = index === 0;
    $('#vNext').disabled = index === list.length - 1;
  }

  function show() {
    const item = list[index];
    if (!item) return;
    renderInfo();
    const my = ++token;
    $('#vError').hidden = true;
    $('#vLoading').hidden = false;
    img.hidden = true;
    img.onload = () => {
      if (my !== token) return;
      $('#vLoading').hidden = true;
      img.hidden = false;
      api.onLoaded?.(item, img.naturalWidth, img.naturalHeight);
    };
    img.onerror = () => {
      if (my !== token) return;
      $('#vLoading').hidden = true;
      $('#vError').hidden = false;
      $('#vErrNext').hidden = index >= list.length - 1;
      const canMove = lastDir > 0 ? index < list.length - 1 : index > 0;
      if ($('#vAutoSkip').checked && canMove) {
        setTimeout(() => my === token && go(lastDir), 500);
      }
    };
    img.src = item.originalUrl;
    // Preload the neighbour in the direction of travel.
    const next = list[index + lastDir];
    if (next) new Image().src = next.originalUrl;
  }

  function go(dir) {
    const target = index + dir;
    lastDir = dir;
    if (target < 0 || target >= list.length) {
      toast(dir > 0 ? '마지막 이미지입니다.' : '첫 번째 이미지입니다.');
      return;
    }
    index = target;
    stage.scrollTo(0, 0);
    show();
  }

  function toggleSelect() {
    const item = list[index];
    api.setSelected(item.id, !api.isSelected(item.id));
    $('#vSelect').checked = api.isSelected(item.id);
  }

  $('#vPrev').addEventListener('click', () => go(-1));
  $('#vNext').addEventListener('click', () => go(1));
  $('#vErrNext').addEventListener('click', () => go(1));
  $('#vClose').addEventListener('click', close);
  $('#vSelect').addEventListener('change', (e) => api.setSelected(list[index].id, e.target.checked));
  $('#vDownload').addEventListener('click', () => api.download([list[index]]));
  $('#vNoThumb').addEventListener('change', (e) => api.setExcludeThumbs(e.target.checked));
  $('#vAutoSkip').addEventListener('change', (e) => api.setAutoSkip(e.target.checked));
  img.addEventListener('click', () => stage.classList.toggle('actual'));

  document.addEventListener('keydown', (e) => {
    if (root.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') return;
    const keys = {
      ArrowLeft: () => go(-1),
      ArrowRight: () => go(1),
      PageUp: () => go(-1),
      PageDown: () => go(1),
      Home: () => go(-index),
      End: () => go(list.length - 1 - index),
      ' ': toggleSelect,
      d: () => api.download([list[index]]),
      D: () => api.download([list[index]]),
      f: () => stage.classList.toggle('actual'),
      F: () => stage.classList.toggle('actual'),
      Escape: close,
    };
    const fn = keys[e.key];
    if (!fn) return;
    e.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    fn();
  });

  return { open, close, refresh, isOpen: () => !root.hidden };
}
