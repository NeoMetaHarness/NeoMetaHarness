import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogId } from '../src/catalog.js';
import { openSurface } from '../src/render-model.js';

test('Web Core mounts the Neo catalog and preserves editable fields', () => {
  const { surface, dispose } = openSurface({
    version: '1.0', createSurface: {
      surfaceId: 'example', catalogId, dataModel: { name: 'Ada' }, components: [
        { id: 'root', component: 'Column', children: ['title', 'field'] },
        { id: 'title', component: 'Heading', text: 'Survey' },
        { id: 'field', component: 'TextField', label: 'Name', value: { '@path': '/name' } },
      ],
    },
  });
  try {
    assert.equal(surface.componentsModel.get('root')?.componentTree.component, 'Column');
    assert.equal(surface.componentsModel.get('title')?.componentTree.text, 'Survey');
    assert.equal(surface.dataModel.get('/name'), 'Ada');
    surface.dataModel.set('/name', 'Turing');
    assert.equal(surface.dataModel.get('/name'), 'Turing');
  } finally {
    dispose();
  }
});
