// prof.lockqz.com is a short spelling of the professor site: every visit is sent on to
// professor.lockqz.com, same path and query. Workers Free, no storage. Deployed by hand from
// app/redirect (npx wrangler deploy); not part of the Release workflow.
export default {
  fetch(request, env) {
    const u = new URL(request.url);
    const to = new URL(env.TO || "https://professor.lockqz.com");
    to.pathname = u.pathname; to.search = u.search;
    return Response.redirect(to.toString(), 301);
  },
};
