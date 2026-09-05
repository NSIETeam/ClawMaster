import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CustomerModuleAuthoringDialog } from './CustomerModuleAuthoringDialog.js';

describe('CustomerModuleAuthoringDialog', () => {
  it('starts at the six-step identity form and supports keyboard dismissal with focus restoration', () => {
    const trigger = document.createElement('button'); trigger.textContent = 'trigger'; document.body.append(trigger); trigger.focus();
    const onClose = vi.fn();
    const view = render(<CustomerModuleAuthoringDialog open publisher={{ id: 'publisher', name: 'King' }} onSubmit={vi.fn()} onClose={onClose} />);
    expect(screen.getByText(/步骤 1\/6/)).toBeTruthy();
    const progress = screen.getByRole('list', { name: '创建进度' });
    expect(within(progress).getAllByRole('listitem')).toHaveLength(6);
    expect(within(progress).getByText('基本信息').closest('li')?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByRole('group', { name: '模块身份' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '模块名称' }).hasAttribute('required')).toBe(true);
    expect(screen.getByRole('textbox', { name: '模块说明' }).hasAttribute('required')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭创建模块' }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: '创建客户模块' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<CustomerModuleAuthoringDialog open={false} publisher={{ id: 'publisher', name: 'King' }} onSubmit={vi.fn()} onClose={onClose} />);
    expect(document.activeElement).toBe(trigger);
  });
});
