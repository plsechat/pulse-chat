/**
 * @name Server-side request forgery
 * @description Making a network request with user-controlled data in the URL
 *              allows for request forgery attacks.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 9.1
 * @precision high
 * @id js/request-forgery
 * @tags security
 *       external/cwe/cwe-918
 */

import javascript
import semmle.javascript.security.dataflow.RequestForgeryQuery
import RequestForgeryFlow::PathGraph

/**
 * Treat calls to validateFederationUrl() as a request-forgery sanitizer.
 *
 * validateFederationUrl (apps/server/src/utils/validate-url.ts) validates that
 * a URL does not target private or internal network resources by:
 *  - Rejecting non-HTTP(S) schemes
 *  - Checking the hostname against private IP ranges (RFC 1918, loopback, link-local)
 *  - Resolving DNS and checking resolved IPs against the same private ranges
 *
 * The function throws if the URL is unsafe, so if execution continues past the
 * call, the returned URL object is safe to fetch. Marking the call node as a
 * barrier prevents taint from flowing through the return value.
 */
private class ValidateFederationUrlSanitizer extends RequestForgery::Sanitizer {
  ValidateFederationUrlSanitizer() {
    exists(DataFlow::CallNode call |
      call.getCalleeName() = "validateFederationUrl" and
      this = call
    )
  }
}

from
  RequestForgeryFlow::PathNode source, RequestForgeryFlow::PathNode sink,
  DataFlow::Node request
where
  RequestForgeryFlow::flowPath(source, sink) and
  request = sink.getNode().(RequestForgery::Sink).getARequest()
select request, source, sink, "The $@ of this request depends on a $@.",
  sink.getNode(), sink.getNode().(RequestForgery::Sink).getKind(), source,
  "user-provided value"
