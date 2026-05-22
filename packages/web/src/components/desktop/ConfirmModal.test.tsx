// packages/web/src/components/desktop/ConfirmModal.test.tsx
//
// Phase C — Step 14 : smoke tests for `ConfirmModal`.
//
// Contract documented in `docs/redesign-desktop/14_confirm-modal.md` §9.2.
// Pure UI component — no network, no global store.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmModal from './ConfirmModal';

describe('ConfirmModal', () => {
  const baseProps = {
    label: 'KILL WORKER',
    body: 'will terminate this worker',
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
  };

  it('renders label and body', () => {
    render(<ConfirmModal {...baseProps} />);
    expect(screen.getByText('KILL WORKER')).toBeInTheDocument();
    expect(screen.getByText(/will terminate/)).toBeInTheDocument();
  });

  it('focuses CANCEL on mount', () => {
    render(<ConfirmModal {...baseProps} />);
    expect(screen.getByText('CANCEL')).toHaveFocus();
  });

  it('calls onCancel when CANCEL clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal {...baseProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('CANCEL'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onConfirm when CONFIRM clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal {...baseProps} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('CONFIRM'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel on backdrop click', () => {
    const onCancel = vi.fn();
    const { container } = render(<ConfirmModal {...baseProps} onCancel={onCancel} />);
    fireEvent.click(container.querySelector('.modal-backdrop')!);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does NOT close when clicking inside the modal box', () => {
    const onCancel = vi.fn();
    const { container } = render(<ConfirmModal {...baseProps} onCancel={onCancel} />);
    fireEvent.click(container.querySelector('.modal')!);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel on Escape key', () => {
    const onCancel = vi.fn();
    const { container } = render(<ConfirmModal {...baseProps} onCancel={onCancel} />);
    fireEvent.keyDown(container.querySelector('.modal-backdrop')!, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does NOT call onConfirm on Enter when cls=danger', () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <ConfirmModal {...baseProps} cls="danger" onConfirm={onConfirm} />,
    );
    fireEvent.keyDown(container.querySelector('.modal-backdrop')!, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('calls onConfirm on Enter when cls=primary', () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <ConfirmModal {...baseProps} cls="primary" onConfirm={onConfirm} />,
    );
    fireEvent.keyDown(container.querySelector('.modal-backdrop')!, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('applies cls to CONFIRM button', () => {
    render(<ConfirmModal {...baseProps} cls="primary" />);
    expect(screen.getByText('CONFIRM').className).toContain('primary');
  });

  it('defaults cls to danger', () => {
    render(<ConfirmModal {...baseProps} />);
    expect(screen.getByText('CONFIRM').className).toContain('danger');
  });

  it('sets aria-modal and labelledby/describedby', () => {
    render(<ConfirmModal {...baseProps} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'confirm-modal-title');
    expect(dialog).toHaveAttribute('aria-describedby', 'confirm-modal-body');
  });
});
