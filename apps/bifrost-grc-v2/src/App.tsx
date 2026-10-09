import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { BifrostHeader } from "bifrost";
import { Toaster } from "sonner";

import RootLayout from "./_layout";
import AppErrorBoundary from "./components/shared/AppErrorBoundary";
import { DirectoryProvider } from "./lib/directory";
import { OrganizationViewProvider } from "./lib/organization-view";
import { FactWorkspaceProvider } from "./lib/open-items";
import PolicySignoffPreview from "./components/policy-signoff/PolicySignoffPreview";
import BasePolicyOrganizationsPreview from "./components/policy-signoff/BasePolicyOrganizationsPreview";

const Dashboard = lazy(() => import("./pages/index"));
const Frameworks = lazy(() => import("./pages/frameworks/index"));
const FrameworkDetail = lazy(() => import("./pages/frameworks/[id]"));
const Controls = lazy(() => import("./pages/controls/index"));
const AppliedControls = lazy(() => import("./pages/applied-controls/index"));
const AppliedControlDetail = lazy(() => import("./pages/applied-controls/[id]"));
const Policies = lazy(() => import("./pages/policies/index"));
const PolicyDetail = lazy(() => import("./pages/policies/[id]"));
const PolicyTemplateDetail = lazy(() => import("./pages/policy-templates/[id]"));
const Risks = lazy(() => import("./pages/risks/index"));
const RiskDetail = lazy(() => import("./pages/risks/[id]"));
const Exceptions = lazy(() => import("./pages/exceptions/index"));
const ExceptionDetail = lazy(() => import("./pages/exceptions/[id]"));
const Evidence = lazy(() => import("./pages/evidence/index"));
const EvidenceDetail = lazy(() => import("./pages/evidence/[id]"));
const Assessments = lazy(() => import("./pages/assessments/index"));
const AssessmentDetail = lazy(() => import("./pages/assessments/[id]"));
const Questionnaires = lazy(() => import("./pages/questionnaires/index"));
const QuestionnaireDetail = lazy(() => import("./pages/questionnaires/[id]"));
const SourceDocuments = lazy(() => import("./pages/source-documents/index"));
const SourceDocumentDetail = lazy(() => import("./pages/source-documents/[id]"));
const Settings = lazy(() => import("./pages/settings/index"));
const OpenItems = lazy(() => import("./pages/open-items/index"));

function AppRoutes() {
  const location = useLocation();

  return (
    <AppErrorBoundary resetKey={location.pathname}>
      <Suspense
        fallback={
          <div className="cv-route-loading" role="status" aria-live="polite">
            Loading GRC workspace…
          </div>
        }
      >
        <Routes>
          <Route element={<RootLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="frameworks" element={<Frameworks />} />
            <Route path="frameworks/:id" element={<FrameworkDetail />} />
            <Route path="controls" element={<Controls />} />
            <Route path="applied-controls" element={<AppliedControls />} />
            <Route path="applied-controls/:id" element={<AppliedControlDetail />} />
            <Route path="policies" element={<Policies />} />
            <Route path="policies/:id" element={<FactWorkspaceProvider><PolicyDetail /></FactWorkspaceProvider>} />
            <Route path="policy-templates/:id" element={<PolicyTemplateDetail />} />
            <Route path="risks" element={<Risks />} />
            <Route path="risks/:id" element={<RiskDetail />} />
            <Route path="exceptions" element={<Exceptions />} />
            <Route path="exceptions/:id" element={<ExceptionDetail />} />
            <Route path="evidence" element={<Evidence />} />
            <Route path="evidence/:id" element={<EvidenceDetail />} />
            <Route path="assessments" element={<Assessments />} />
            <Route path="assessments/:id" element={<AssessmentDetail />} />
            <Route path="questionnaires" element={<Questionnaires />} />
            <Route path="questionnaires/:id" element={<QuestionnaireDetail />} />
            <Route path="source-documents" element={<SourceDocuments />} />
            <Route path="source-documents/:id" element={<SourceDocumentDetail />} />
            <Route path="settings" element={<Settings />} />
            <Route path="open-items" element={<FactWorkspaceProvider><OpenItems /></FactWorkspaceProvider>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </AppErrorBoundary>
  );
}

function GrcHeader() {
  // Deployed apps should let the SDK retrieve the installed application logo
  // with its authenticated transport. Direct Vite development has no app ID,
  // so it falls back to the public asset served by the local root.
  return <BifrostHeader className="cv-bifrost-header" title="Bifrost GRC" logo={import.meta.env.DEV ? "/grc-logo.svg" : undefined} />;
}

export default function App() {
  if (import.meta.env.DEV && window.location.pathname === "/__signoff-preview") {
    return <><GrcHeader /><PolicySignoffPreview /></>;
  }
  if (import.meta.env.DEV && window.location.pathname === "/__organizations-preview") {
    return <><GrcHeader /><BasePolicyOrganizationsPreview /></>;
  }
  return (
    <DirectoryProvider>
      <OrganizationViewProvider>
        <div className="flex h-full min-h-0 flex-col">
          <GrcHeader />
          <div className="min-h-0 flex-1">
            <AppRoutes />
          </div>
          <Toaster closeButton position="top-right" toastOptions={{ className: "bds-toast" }} />
        </div>
      </OrganizationViewProvider>
    </DirectoryProvider>
  );
}
