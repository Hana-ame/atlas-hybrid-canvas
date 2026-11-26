import { ControllableEdge } from '../src/canvas/ControllableEdge.tsx';
import { ReactFlowProvider } from '@xyflow/react';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CanvasErrorBoundary } from '../src/components/CanvasErrorBoundary.tsx';
import { TemplateDrawer } from '../src/components/TemplateDrawer.tsx';
import { SearchJumpModal } from '../src/components/SearchJumpModal.tsx';
import { ScriptTrustModal } from '../src/components/ScriptTrustModal.tsx';
import { NodeInspectorPanel } from '../src/components/NodeInspectorPanel.tsx';
import { ImageNodeBlock } from '../src/canvas/ImageNodeBlock.tsx';
import { VideoNodeBlock } from '../src/canvas/VideoNodeBlock.tsx';
import { SliderControlBlock } from '../src/canvas/SliderControlBlock.tsx';
import { Pad2DControlBlock } from '../src/canvas/Pad2DControlBlock.tsx';
import { ImageButtonBlock } from '../src/canvas/ImageButtonBlock.tsx';
import { ApiPollerBlock } from '../src/canvas/ApiPollerBlock.tsx';
import { PdfViewerBlock } from '../src/canvas/PdfViewerBlock.tsx';
import { SmartNodeResizer } from '../src/canvas/SmartNodeResizer.tsx';
import { WidgetNode } from '../src/canvas/WidgetNode.tsx';
import { AnnotationNode } from '../src/canvas/AnnotationNode.tsx';
import { ChunkUnderlayCanvas } from '../src/canvas/ChunkUnderlayCanvas.tsx';
import { renderContentBlock } from '../src/canvas/contentBlockRegistry.tsx';
import App from '../src/App.tsx';
import { createSeedBlueprint } from '../src/core/seedBlueprint.ts';

test('CanvasErrorBoundary renders children normally and derives error state for app & node variants', () => {
  const okHtml = renderToStaticMarkup(
    React.createElement(CanvasErrorBoundary, { variant: 'app' }, React.createElement('span', null, 'safe-child'))
  );
  assert.ok(okHtml.includes('safe-child'));

  const derived = CanvasErrorBoundary.getDerivedStateFromError(new Error('boom-widget'));
  assert.deepEqual(derived, { hasError: true, message: 'boom-widget' });

  const nodeBoundary = new CanvasErrorBoundary({
    variant: 'node',
    label: 'BrokenCard',
    children: null,
  });
  nodeBoundary.state = derived;
  const nodeFallback = renderToStaticMarkup(nodeBoundary.render() as React.ReactElement);
  assert.ok(nodeFallback.includes('BrokenCard'));
  assert.ok(nodeFallback.includes('boom-widget'));
  assert.ok(nodeFallback.includes('重试渲染'));
});

test('UI modals and panels (TemplateDrawer, SearchJumpModal, ScriptTrustModal, NodeInspectorPanel) render expected content', () => {
  const drawerHtml = renderToStaticMarkup(
    React.createElement(TemplateDrawer, {
      open: true,
      templates: [],
      onClose: () => {},
      onCreateCenter: () => {},
      onDeleteCustomTemplate: () => {},
    })
  );
  assert.ok(drawerHtml.length > 50);

  const seed = createSeedBlueprint();
  const firstNode = Object.values(seed.nodes)[0];
  const effectiveFirst = {
    ...firstNode,
    effectiveVars: firstNode.vars ?? {},
    hasLocalOverride: false,
    hasRuntimeVars: false,
  } as any;

  const searchHtml = renderToStaticMarkup(
    React.createElement(SearchJumpModal, {
      open: true,
      nodes: { [firstNode.id]: effectiveFirst },
      annotations: seed.annotations,
      onClose: () => {},
      onJumpToPoint: () => {},
    })
  );
  assert.ok(searchHtml.includes(firstNode.title));

  const trustHtml = renderToStaticMarkup(
    React.createElement(ScriptTrustModal, {
      open: true,
      sourceLabel: '测试来源',
      entries: [
        {
          key: 'node:n1:script',
          nodeId: 'n1',
          nodeTitle: 'Risky Node',
          kind: 'unified_script',
          summary: '包含自定义脚本',
          codePreview: 'return 1;',
        },
      ],
      onTrustAll: () => {},
      onKeepLocked: () => {},
    })
  );
  assert.ok(trustHtml.includes('Risky Node'));

  const inspectorHtml = renderToStaticMarkup(
    React.createElement(NodeInspectorPanel, {
      node: effectiveFirst,
      scriptLogs: [],
      onClose: () => {},
      onPatchNode: () => {},
      onRunScriptRefresh: () => {},
      onUpdateDefaultVar: () => {},
      onDeleteDefaultVar: () => {},
      onClearScriptLogs: () => {},
      onResetLocal: () => {},
      onDeleteNode: () => {},
      onDuplicateNode: () => {},
      onSaveAsTemplate: () => {},
    })
  );
  assert.ok(inspectorHtml.includes(firstNode.title));
});

test('Canvas media/control blocks and contentBlockRegistry render valid controls and reject unsafe blob: URLs', () => {
  const imgSafe = renderToStaticMarkup(
    React.createElement(ImageNodeBlock, {
      url: 'https://example.com/pic.png',
      caption: 'Demo Pic',
      onChangeUrl: () => {},
    })
  );
  assert.ok(imgSafe.includes('https://example.com/pic.png'));

  const imgBlocked = renderToStaticMarkup(
    React.createElement(ImageNodeBlock, {
      url: 'blob:http://localhost/evil',
      caption: 'Blocked',
      onChangeUrl: () => {},
    })
  );
  assert.equal(imgBlocked.includes('<img'), false);

  const vidSafe = renderToStaticMarkup(
    React.createElement(VideoNodeBlock, {
      url: 'https://example.com/clip.mp4',
      mediaActive: false,
      onChangeUrl: () => {},
    })
  );
  assert.ok(vidSafe.includes('https://example.com/clip.mp4'));

  const sliderHtml = renderToStaticMarkup(
    React.createElement(SliderControlBlock, {
      label: 'Gain',
      value: 42,
      min: 0,
      max: 100,
      step: 1,
      unit: '%',
      onChange: () => {},
    })
  );
  assert.ok(sliderHtml.includes('Gain'));
  assert.ok(sliderHtml.includes('42'));

  const padHtml = renderToStaticMarkup(
    React.createElement(Pad2DControlBlock, {
      label: 'XY Pad',
      x: 0.5,
      y: -0.5,
      minX: -1,
      maxX: 1,
      minY: -1,
      maxY: 1,
      onChange: () => {},
    })
  );
  assert.ok(padHtml.includes('XY Pad'));

  const btnHtml = renderToStaticMarkup(
    React.createElement(ImageButtonBlock, {
      label: 'Power',
      active: true,
      onUrl: 'https://example.com/on.png',
      offUrl: 'https://example.com/off.png',
      onTrigger: () => {},
    })
  );
  assert.ok(btnHtml.includes('Power'));

  const pollerHtml = renderToStaticMarkup(
    React.createElement(ApiPollerBlock, {
      nodeId: 'n-poll',
      url: 'https://api.github.com/zen',
      intervalSec: 30,
      active: false,
      onBatchUpdateVars: () => {},
    })
  );
  assert.ok(pollerHtml.length > 20);

  const pdfHtml = renderToStaticMarkup(React.createElement(ReactFlowProvider, null, React.createElement(PdfViewerBlock, {
      nodeId: 'n-pdf',
      url: 'https://example.com/doc.pdf',
      page: 1,
      totalPages: 5,
      onBatchUpdateVars: () => {},
    })));
  assert.ok(pdfHtml.length > 20);

  // Verify contentBlockRegistry renders a text block cleanly
  const seed = createSeedBlueprint();
  const entity = {
    ...Object.values(seed.nodes)[0],
    effectiveVars: {},
    hasLocalOverride: false,
    hasRuntimeVars: false,
  } as any;
  const regEl = renderContentBlock(
    { type: 'text', text: 'Registry Hello' } as any,
    {
      entity,
      idx: 0,
      inRow: false,
      busyButtonKey: null,
      mediaActive: false,
      onRunScriptClick: () => {},
      onScriptInputChange: () => {},
      onSliderChange: () => {},
      onSliderCommit: () => {},
      onPad2DChange: () => {},
      onPad2DCommit: () => {},
      onImageButtonTrigger: () => {},
      onBatchUpdateVars: () => {},
      onScriptInputSubmit: () => {},
    }
  );
  assert.ok(renderToStaticMarkup(regEl as React.ReactElement).includes('Registry Hello'));

  // Verify remaining canvas/app component exports are valid React components
  assert.ok(SmartNodeResizer);
  assert.ok(WidgetNode);
  assert.ok(AnnotationNode);
  assert.ok(ChunkUnderlayCanvas);
  assert.equal(typeof App, 'function');
});

test('ControllableEdge renders origin anchor dot, smooth path, control point handles when selected, and label pill', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ReactFlowProvider,
      null,
      React.createElement(
        'svg',
        null,
        React.createElement(ControllableEdge, {
          id: 'edge-test-1',
          source: 'n1',
          target: 'n2',
          sourceX: 100,
          sourceY: 100,
          targetX: 400,
          targetY: 200,
          sourcePosition: 'right' as any,
          targetPosition: 'left' as any,
          selected: true,
          label: 'cancel',
          style: { stroke: '#DC2626' },
          data: {
            controlPoints: [{ x: 250, y: 40 }],
            sourceTitle: 'RUNNING',
            targetTitle: 'IDLE',
            onUpdateControlPoints: () => {},
          },
        } as any)
      )
    )
  );
  assert.ok(html.includes('250.0 40.0') || html.includes('250, 40'), 'should render control point path/handle');
  assert.ok(html.includes('#DC2626'), 'should apply edge stroke color');
  assert.ok(html.includes('nodrag nopan edge-control-handle'), 'control point handles must isolate canvas pan/drag');
  assert.ok(html.includes('pointer-events="all"'), 'control point handles must override visibleStroke pointer-events');
});

test('ControllableEdge omits origin dot when bidirectional markerStart is present', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ReactFlowProvider,
      null,
      React.createElement(
        'svg',
        null,
        React.createElement(ControllableEdge, {
          id: 'edge-bi',
          source: 'n1',
          target: 'n2',
          sourceX: 100,
          sourceY: 100,
          targetX: 300,
          targetY: 100,
          sourcePosition: 'right' as any,
          targetPosition: 'left' as any,
          selected: false,
          markerStart: 'url(#arrow-start)',
          style: { stroke: '#2563EB' },
          data: {},
        } as any)
      )
    )
  );
  assert.equal(html.includes('cx="100"'), false, 'should not draw origin dot on top of bidirectional markerStart arrow');
});

test('WidgetNode & button blocks prevent layout shift and render vars as a fixed-height horizontal scroll row', () => {
  const seed = createSeedBlueprint();
  const baseNode = Object.values(seed.nodes)[0];
  const entity = {
    ...baseNode,
    id: 'node-btn-layout',
    title: 'Layout Stable Card',
    buttons: [
      { id: 'btn-sq', label: '算 5² (POST /demo/square)', actionType: 'proxy_http', proxyUrl: '/demo/square', variant: 'primary' },
    ],
    defaultVars: { lastHttpStatus: 200 },
    effectiveVars: { lastHttpStatus: 200, lastHttpResponse: { square: 25 } },
    hasLocalOverride: false,
    hasRuntimeVars: true,
  } as any;
  const noop = () => {};
  const renderWidget = (targetEntity: any, busyButtonKey: string | null) =>
    renderToStaticMarkup(
      React.createElement(
        ReactFlowProvider,
        null,
        React.createElement(WidgetNode as any, {
          id: targetEntity.id,
          selected: false,
          data: {
            entity: targetEntity,
            onRunButton: noop,
            onRunScriptClick: noop,
            onScriptInputChange: noop,
            onScriptInputSubmit: noop,
            onToggleLock: noop,
            onResetLocal: noop,
            onEditTitle: noop,
            onEditBody: noop,
            onResizeNode: noop,
            onOpenInspector: noop,
            onDuplicateNode: noop,
            onDeleteNode: noop,
            busyButtonKey,
          },
        })
      )
    );

  const html = renderWidget(entity, 'node-btn-layout:btn-sq');
  assert.ok(html.includes('算 5² (POST /demo/square)'), 'busy button should retain original label width');
  assert.equal(html.includes('执行中…'), false, 'busy button should not replace label with shorter 执行中… text');
  assert.ok(html.includes('animate-spin'), 'busy button should display spinner icon while loading');
  assert.ok(html.includes('vars-scroll-row') && html.includes('overflow-x-auto'), 'vars must render in a single-line horizontally scrollable row');
  assert.ok(html.includes('whitespace-nowrap'), 'var pills must stay on a single line without wrapping');
  const btnIdx = html.indexOf('算 5² (POST /demo/square)');
  const varsIdx = html.indexOf('vars-scroll-row');
  assert.ok(btnIdx > -1 && varsIdx > -1 && btnIdx < varsIdx, 'buttons must stay above fixed bottom vars bar');

  const emptyVarsHtml = renderWidget({ ...entity, defaultVars: {}, effectiveVars: {}, hasRuntimeVars: false }, null);
  assert.ok(emptyVarsHtml.includes('vars-scroll-row') && emptyVarsHtml.includes('vars: 暂无'), 'button widgets should reserve fixed single-line vars bar height even before first click');

  const scriptBtnEl = renderContentBlock(
    { type: 'button', id: 'run-demo', label: 'Run Demo Task', variant: 'primary' } as any,
    {
      entity: { ...entity, id: 'node-script-btn' },
      idx: 0,
      inRow: false,
      busyButtonKey: 'node-script-btn:script:run-demo',
      mediaActive: false,
      onRunScriptClick: noop,
      onScriptInputChange: noop,
      onSliderChange: noop,
      onSliderCommit: noop,
      onPad2DChange: noop,
      onPad2DCommit: noop,
      onImageButtonTrigger: noop,
      onBatchUpdateVars: noop,
      onScriptInputSubmit: noop,
    }
  );
  const scriptBtnHtml = renderToStaticMarkup(scriptBtnEl as React.ReactElement);
  assert.ok(scriptBtnHtml.includes('Run Demo Task'), 'busy script button should preserve label');
  assert.equal(scriptBtnHtml.includes('执行中…'), false, 'busy script button should not swap label text');
  assert.ok(scriptBtnHtml.includes('animate-spin'), 'busy script button should animate icon only');
});
