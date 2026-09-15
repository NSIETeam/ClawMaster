// Library subprocess fixture: this entry does not launch a DSH application.
process.once('message', async ({ moduleUrl, options }) => {
  try {
    const { activateComponent } = await import(moduleUrl);
    process.send({ status: 'starting' });
    const result = await activateComponent(options);
    process.send({ status: 'resolved', result });
  } catch (error) {
    process.send({ status: 'rejected', message: error.message });
  } finally { process.disconnect(); }
});
