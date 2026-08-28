export function RegistrationCompletionCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      className="w-full rounded-full bg-[#06C755] py-3 text-base font-bold text-white shadow active:opacity-80"
    >
      閉じる
    </button>
  );
}
