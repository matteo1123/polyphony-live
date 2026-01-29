document.addEventListener('DOMContentLoaded', () => {
  const createBtn = document.getElementById('createSpace');
  const spaceLinkDiv = document.getElementById('spaceLink');
  const spaceLinkInput = document.getElementById('spaceLinkInput');
  const copyLinkBtn = document.getElementById('copyLink');
  const goToSpaceBtn = document.getElementById('goToSpace');

  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';

    try {
      const response = await fetch('/api/space/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        throw new Error('Failed to create space');
      }

      const data = await response.json();
      const spaceUrl = `${window.location.origin}/space/${data.spaceId}`;

      spaceLinkInput.value = spaceUrl;
      goToSpaceBtn.href = `/space/${data.spaceId}`;
      spaceLinkDiv.classList.remove('hidden');

      createBtn.textContent = 'Generate Another Space';
      createBtn.disabled = false;
    } catch (error) {
      console.error('Error creating space:', error);
      createBtn.textContent = 'Error - Try Again';
      createBtn.disabled = false;
    }
  });

  copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(spaceLinkInput.value);
      copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyLinkBtn.textContent = 'Copy';
      }, 2000);
    } catch (error) {
      // Fallback for older browsers
      spaceLinkInput.select();
      document.execCommand('copy');
      copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyLinkBtn.textContent = 'Copy';
      }, 2000);
    }
  });
});
